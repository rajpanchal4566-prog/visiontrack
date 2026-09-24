// ==============================================================================
// VisionTrack — Pretrained Neural Seatbelt Classifier
// Pretrained YOLOv11s-cls binary classification model for driver seatbelt detection
// Hugging Face: RISEF/yolov11s-seatbelt (ONNX export)
// Classes: 0: no_seatbelt, 1: seat_belt
// ==============================================================================

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const ort = require('onnxruntime-node');

const DEFAULT_MODEL_PATH = path.join(__dirname, '..', '..', 'models', 'seatbelt-yolo11.onnx');
const INPUT_SIZE = 224;
const DEFAULT_NO_SEATBELT_THRESHOLD = 0.50;

let sessionPromise = null;

function getModelPath() {
  return process.env.SEATBELT_MODEL_PATH
    ? path.resolve(process.env.SEATBELT_MODEL_PATH)
    : DEFAULT_MODEL_PATH;
}

function isSeatbeltModelAvailable(modelPath = getModelPath()) {
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

/**
 * Softmax function to convert raw logits to probabilities if needed.
 */
function softmax(logits) {
  const max = Math.max(...logits);
  const exps = logits.map(v => Math.exp(v - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map(v => v / sum);
}

/**
 * Classify driver seatbelt presence for a four-wheeler vehicle.
 *
 * @param {Buffer} imageBuffer - Full frame buffer or cabin crop
 * @param {object} [vehicleBbox] - Bounding box { x, y, width, height } of the vehicle
 * @param {object} [options]
 * @returns {Promise<{
 *   success: boolean,
 *   hasSeatbelt: boolean,
 *   violation: boolean,
 *   confidence: number,
 *   predictedClass: 'no_seatbelt'|'seat_belt',
 *   probabilities: { no_seatbelt: number, seat_belt: number },
 *   cropBbox: object|null,
 *   latencyMs: number,
 *   status: string
 * }>}
 */
async function classifySeatbelt(imageBuffer, vehicleBbox = null, options = {}) {
  const startTime = performance.now();

  if (!imageBuffer || !Buffer.isBuffer(imageBuffer) || imageBuffer.length === 0) {
    return {
      success: false,
      hasSeatbelt: true,
      violation: false,
      confidence: 0,
      predictedClass: 'seat_belt',
      probabilities: { no_seatbelt: 0, seat_belt: 1 },
      cropBbox: null,
      latencyMs: 0,
      status: 'invalid_image',
    };
  }

  const session = await getSession();
  if (!session) {
    return {
      success: false,
      hasSeatbelt: true,
      violation: false,
      confidence: 0,
      predictedClass: 'seat_belt',
      probabilities: { no_seatbelt: 0, seat_belt: 1 },
      cropBbox: null,
      latencyMs: 0,
      status: 'model_unavailable',
    };
  }

  try {
    const meta = await sharp(imageBuffer).metadata();
    let cropBuffer = imageBuffer;
    let cabinBbox = null;

    if (vehicleBbox && vehicleBbox.width >= 20 && vehicleBbox.height >= 20) {
      // Windshield / driver cabin: upper 50% of the vehicle body
      const left = Math.max(0, Math.min(meta.width - 1, Math.round(vehicleBbox.x + vehicleBbox.width * 0.15)));
      const top = Math.max(0, Math.min(meta.height - 1, Math.round(vehicleBbox.y + vehicleBbox.height * 0.10)));
      const width = Math.max(16, Math.min(meta.width - left, Math.round(vehicleBbox.width * 0.70)));
      const height = Math.max(16, Math.min(meta.height - top, Math.round(vehicleBbox.height * 0.50)));

      cabinBbox = { x: left, y: top, width, height };
      cropBuffer = await sharp(imageBuffer)
        .extract({ left, top, width, height })
        .toBuffer();
    }

    // Preprocess: resize to 224x224 RGB float32
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

    // Output shape: [1, 2] (class 0: no_seatbelt, class 1: seat_belt)
    const rawOut = Array.from(results.output0.data);
    const isSoftmax = Math.abs((rawOut[0] + rawOut[1]) - 1.0) < 0.05;
    const probs = isSoftmax ? rawOut : softmax(rawOut);

    const probNoSeatbelt = Number(probs[0].toFixed(4));
    const probSeatbelt = Number(probs[1].toFixed(4));

    const threshold = options.threshold ?? DEFAULT_NO_SEATBELT_THRESHOLD;
    const violation = probNoSeatbelt >= threshold;
    const hasSeatbelt = !violation;
    const confidence = violation ? probNoSeatbelt : probSeatbelt;
    const predictedClass = violation ? 'no_seatbelt' : 'seat_belt';

    const latencyMs = Number((performance.now() - startTime).toFixed(2));

    return {
      success: true,
      hasSeatbelt,
      violation,
      confidence,
      predictedClass,
      probabilities: {
        no_seatbelt: probNoSeatbelt,
        seat_belt: probSeatbelt,
      },
      cropBbox: cabinBbox,
      latencyMs,
      status: 'classified',
    };
  } catch (error) {
    return {
      success: false,
      hasSeatbelt: true,
      violation: false,
      confidence: 0,
      predictedClass: 'seat_belt',
      probabilities: { no_seatbelt: 0, seat_belt: 1 },
      cropBbox: null,
      latencyMs: Number((performance.now() - startTime).toFixed(2)),
      status: 'error',
      error: error.message,
    };
  }
}

async function shutdownSeatbeltClassifier() {
  if (sessionPromise) {
    const session = await sessionPromise;
    if (session && session.release) await session.release();
    sessionPromise = null;
  }
}

module.exports = {
  classifySeatbelt,
  isSeatbeltModelAvailable,
  shutdownSeatbeltClassifier,
  DEFAULT_MODEL_PATH,
};
