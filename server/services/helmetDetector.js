// ==============================================================================
// VisionTrack — Pretrained Neural Helmet Detector
// Pretrained YOLOv8n object detection model for helmet & head detection
// Hugging Face: fiacecson20/cctv-ai-ppe (ONNX export)
// Classes: 0: helmet, 1: head (vest class ignored)
// ==============================================================================

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const ort = require('onnxruntime-node');

const DEFAULT_MODEL_PATH = path.join(__dirname, '..', '..', 'models', 'helmet-yolov8.onnx');
const INPUT_SIZE = 320;
const DEFAULT_CONF_THRESHOLD = 0.25;
const DEFAULT_IOU_THRESHOLD = 0.45;

let sessionPromise = null;

function getModelPath() {
  return process.env.HELMET_MODEL_PATH
    ? path.resolve(process.env.HELMET_MODEL_PATH)
    : DEFAULT_MODEL_PATH;
}

function isHelmetModelAvailable(modelPath = getModelPath()) {
  return fs.existsSync(modelPath);
}

async function getSession(modelPath = getModelPath()) {
  if (!fs.existsSync(modelPath)) {
    return null;
  }
  if (!sessionPromise) {
    sessionPromise = (async () => {
      const sessionOptions = {
        intraOpNumThreads: 2,
        executionMode: 'sequential',
        graphOptimizationLevel: 'all',
      };
      return await ort.InferenceSession.create(modelPath, sessionOptions);
    })().catch((err) => {
      sessionPromise = null;
      throw err;
    });
  }
  return await sessionPromise;
}

function bboxIoU(b1, b2) {
  const left = Math.max(b1.x, b2.x);
  const top = Math.max(b1.y, b2.y);
  const right = Math.min(b1.x + b1.width, b2.x + b2.width);
  const bottom = Math.min(b1.y + b1.height, b2.y + b2.height);
  const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
  const union = (b1.width * b1.height) + (b2.width * b2.height) - intersection;
  return union > 0 ? intersection / union : 0;
}

function nms(detections, iouThreshold = DEFAULT_IOU_THRESHOLD) {
  detections.sort((a, b) => b.confidence - a.confidence);
  const keep = [];
  for (const det of detections) {
    const overlaps = keep.some(kept => bboxIoU(det.bbox, kept.bbox) > iouThreshold);
    if (!overlaps) keep.push(det);
  }
  return keep;
}

/**
 * Detect helmet / head presence on a two-wheeler rider.
 *
 * @param {Buffer} imageBuffer - Full frame buffer or pre-cropped region
 * @param {object} [riderRegion] - Bounding box { x, y, width, height } of the rider or motorcycle
 * @param {object} [options]
 * @returns {Promise<{
 *   success: boolean,
 *   hasHelmet: boolean,
 *   violation: boolean,
 *   confidence: number,
 *   detections: Array<{ class: string, confidence: number, bbox: object }>,
 *   latencyMs: number,
 *   status: string
 * }>}
 */
async function detectHelmet(imageBuffer, riderRegion = null, options = {}) {
  const startTime = performance.now();

  if (!imageBuffer || !Buffer.isBuffer(imageBuffer) || imageBuffer.length === 0) {
    return {
      success: false,
      hasHelmet: true,
      violation: false,
      confidence: 0,
      detections: [],
      latencyMs: 0,
      status: 'invalid_image',
    };
  }

  const session = await getSession();
  if (!session) {
    return {
      success: false,
      hasHelmet: true,
      violation: false,
      confidence: 0,
      detections: [],
      latencyMs: 0,
      status: 'model_unavailable',
    };
  }

  try {
    const meta = await sharp(imageBuffer).metadata();
    let cropBuffer = imageBuffer;
    let cropOffset = { x: 0, y: 0, width: meta.width, height: meta.height };

    // If region is supplied, crop the rider's upper-body / head area
    if (riderRegion && riderRegion.width >= 10 && riderRegion.height >= 10) {
      const left = Math.max(0, Math.min(meta.width - 1, Math.round(riderRegion.x)));
      const top = Math.max(0, Math.min(meta.height - 1, Math.round(riderRegion.y)));
      const width = Math.max(8, Math.min(meta.width - left, Math.round(riderRegion.width)));
      // Focus on upper 70% of the rider / motorcycle bounding box where the head/helmet sits
      const height = Math.max(8, Math.min(meta.height - top, Math.round(riderRegion.height * 0.70)));

      cropOffset = { x: left, y: top, width, height };
      cropBuffer = await sharp(imageBuffer)
        .extract({ left, top, width, height })
        .toBuffer();
    }

    // Preprocess: resize to 320x320 RGB float32
    const { data } = await sharp(cropBuffer)
      .resize(INPUT_SIZE, INPUT_SIZE, { fit: 'fill' })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const floatData = new Float32Array(3 * INPUT_SIZE * INPUT_SIZE);
    const planeSize = INPUT_SIZE * INPUT_SIZE;
    for (let i = 0; i < planeSize; i++) {
      floatData[i] = data[i * 3] / 255.0;                   // R
      floatData[planeSize + i] = data[i * 3 + 1] / 255.0;   // G
      floatData[2 * planeSize + i] = data[i * 3 + 2] / 255.0; // B
    }

    const tensor = new ort.Tensor('float32', floatData, [1, 3, INPUT_SIZE, INPUT_SIZE]);
    const results = await session.run({ images: tensor });

    // Output shape: [1, 7, 2100] (0:cx, 1:cy, 2:w, 3:h, 4:helmet, 5:head, 6:vest)
    const out = results.output0.data;
    const numAnchors = 2100;
    const confThreshold = options.confThreshold || DEFAULT_CONF_THRESHOLD;
    const rawDetections = [];

    const scaleX = cropOffset.width / INPUT_SIZE;
    const scaleY = cropOffset.height / INPUT_SIZE;

    for (let a = 0; a < numAnchors; a++) {
      const scoreHelmet = out[4 * numAnchors + a];
      const scoreHead = out[5 * numAnchors + a];

      let bestClass = null;
      let bestConf = 0;

      if (scoreHelmet >= confThreshold && scoreHelmet >= scoreHead) {
        bestClass = 'helmet';
        bestConf = scoreHelmet;
      } else if (scoreHead >= confThreshold && scoreHead > scoreHelmet) {
        bestClass = 'head';
        bestConf = scoreHead;
      }

      if (bestClass) {
        const cx = out[0 * numAnchors + a];
        const cy = out[1 * numAnchors + a];
        const w = out[2 * numAnchors + a];
        const h = out[3 * numAnchors + a];

        const x = Math.max(0, (cx - w / 2) * scaleX + cropOffset.x);
        const y = Math.max(0, (cy - h / 2) * scaleY + cropOffset.y);
        const width = w * scaleX;
        const height = h * scaleY;

        rawDetections.push({
          class: bestClass,
          confidence: Number(bestConf.toFixed(4)),
          bbox: {
            x: Math.round(x),
            y: Math.round(y),
            width: Math.round(width),
            height: Math.round(height),
          },
        });
      }
    }

    const filtered = nms(rawDetections, options.iouThreshold || DEFAULT_IOU_THRESHOLD);
    const helmets = filtered.filter(d => d.class === 'helmet');
    const heads = filtered.filter(d => d.class === 'head');

    let hasHelmet = false;
    let violation = false;
    let confidence = 0;

    if (helmets.length > 0) {
      hasHelmet = true;
      violation = false;
      confidence = helmets[0].confidence;
    } else if (heads.length > 0) {
      // Confirmed bare head without helmet
      hasHelmet = false;
      violation = true;
      confidence = heads[0].confidence;
    } else {
      // Neither explicitly detected with high confidence: default to no violation
      hasHelmet = true;
      violation = false;
      confidence = 0.5;
    }

    const latencyMs = Number((performance.now() - startTime).toFixed(2));

    return {
      success: true,
      hasHelmet,
      violation,
      confidence,
      detections: filtered,
      latencyMs,
      status: 'detected',
      helmetCount: helmets.length,
      headCount: heads.length,
    };
  } catch (error) {
    return {
      success: false,
      hasHelmet: true,
      violation: false,
      confidence: 0,
      detections: [],
      latencyMs: Number((performance.now() - startTime).toFixed(2)),
      status: 'error',
      error: error.message,
    };
  }
}

async function shutdownHelmetDetector() {
  if (sessionPromise) {
    const session = await sessionPromise;
    if (session && session.release) await session.release();
    sessionPromise = null;
  }
}

module.exports = {
  detectHelmet,
  isHelmetModelAvailable,
  shutdownHelmetDetector,
  DEFAULT_MODEL_PATH,
};
