// ==============================================================================
// VisionTrack — Neural Plate OCR Service
// Ultra-fast plate character recognition using compact ONNX Transformer (CCT-XS)
// Typical inference latency: ~2.5 ms on CPU (vs ~850 ms with Tesseract.js)
// ==============================================================================

const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const ort = require('onnxruntime-node');

const DEFAULT_MODEL_PATH = path.join(__dirname, '..', '..', 'models', 'license-plate-ocr.onnx');
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_';
const MAX_SLOTS = 10;
const PAD_CHAR = '_';
const INPUT_WIDTH = 128;
const INPUT_HEIGHT = 64;

const sessions = new Map();

function getActiveModelPath(modelPath) {
  return modelPath || process.env.OCR_MODEL_PATH || DEFAULT_MODEL_PATH;
}

/**
 * Lazily initialize or retrieve the cached ONNX Runtime session for the specified model path.
 *
 * @param {string} [modelPath]
 * @returns {Promise<ort.InferenceSession|null>}
 */
async function getSession(modelPath = null) {
  const targetPath = getActiveModelPath(modelPath);
  const resolvedPath = path.resolve(targetPath);
  if (!fs.existsSync(resolvedPath)) {
    return null;
  }
  if (!sessions.has(resolvedPath)) {
    const sessionPromise = (async () => {
      const sessionOptions = {
        intraOpNumThreads: Number(process.env.ONNX_NUM_THREADS) || 4,
        executionMode: 'sequential',
        graphOptimizationLevel: 'all',
      };
      return await ort.InferenceSession.create(resolvedPath, sessionOptions);
    })().catch((err) => {
      sessions.delete(resolvedPath);
      throw err;
    });
    sessions.set(resolvedPath, sessionPromise);
  }
  return await sessions.get(resolvedPath);
}

/**
 * Check if the neural OCR model file is present.
 *
 * @param {string} [modelPath]
 * @returns {boolean}
 */
function isNeuralOcrAvailable(modelPath = null) {
  const targetPath = getActiveModelPath(modelPath);
  return fs.existsSync(path.resolve(targetPath));
}

/**
 * Recognize plate characters directly from an image crop buffer.
 *
 * @param {Buffer} cropBuffer - Raw image buffer (JPEG/PNG) of the cropped plate.
 * @param {string} [modelPath]
 * @returns {Promise<{
 *   success: boolean,
 *   plate: string|null,
 *   rawText: string,
 *   confidence: number,
 *   confidencePercent: number,
 *   charConfidences: number[],
 *   latencyMs: number,
 *   status: string
 * }>}
 */
async function recognizePlateNeural(cropBuffer, modelPath = null) {
  const startTime = performance.now();
  if (!cropBuffer || !Buffer.isBuffer(cropBuffer) || cropBuffer.length === 0) {
    return {
      success: false,
      error: 'invalid_image',
      plate: null,
      rawText: '',
      confidence: 0,
      confidencePercent: 0,
      charConfidences: [],
      latencyMs: 0,
      status: 'invalid_input',
    };
  }

  const session = await getSession(modelPath);
  if (!session) {
    return {
      success: false,
      error: 'model_not_found',
      plate: null,
      rawText: '',
      confidence: 0,
      confidencePercent: 0,
      charConfidences: [],
      latencyMs: 0,
      status: 'model_unavailable',
    };
  }

  try {
    // 1. Preprocess: resize to 128x64 RGB uint8 raw buffer.
    //
    // CRITICAL: In sharp 0.35.4, chaining extend() + resize() in a single pipeline
    // silently ignores the resize — the output stays at the extended dimensions.
    // Fix: split into two separate sharp calls.
    //   Step A: flatten (alpha → white) + extend padding → intermediate PNG
    //   Step B: resize 128×64 (fill) → raw RGB bytes
    //
    const extendedPng = await sharp(cropBuffer)
      .flatten({ background: { r: 255, g: 255, b: 255 } })
      .extend({ top: 4, bottom: 4, left: 12, right: 12, background: { r: 255, g: 255, b: 255 } })
      .png()
      .toBuffer();

    const { data: rawBuffer, info } = await sharp(extendedPng)
      .resize(INPUT_WIDTH, INPUT_HEIGHT, { fit: 'fill' })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    if (info.width !== INPUT_WIDTH || info.height !== INPUT_HEIGHT) {
      throw new Error(`Unexpected crop dimensions after resize: ${info.width}x${info.height}, expected ${INPUT_WIDTH}x${INPUT_HEIGHT}`);
    }

    const expectedSize = INPUT_WIDTH * INPUT_HEIGHT * info.channels;
    // If RGBA (channels=4), strip alpha by re-extracting RGB
    const safeBuffer = info.channels === 4
      ? (() => {
          const rgb = Buffer.allocUnsafe(INPUT_WIDTH * INPUT_HEIGHT * 3);
          for (let px = 0; px < INPUT_WIDTH * INPUT_HEIGHT; px++) {
            rgb[px * 3] = rawBuffer[px * 4];
            rgb[px * 3 + 1] = rawBuffer[px * 4 + 1];
            rgb[px * 3 + 2] = rawBuffer[px * 4 + 2];
          }
          return rgb;
        })()
      : rawBuffer;
    const uint8Array = new Uint8Array(safeBuffer.buffer, safeBuffer.byteOffset, INPUT_WIDTH * INPUT_HEIGHT * 3);
    const tensor = new ort.Tensor('uint8', uint8Array, [1, INPUT_HEIGHT, INPUT_WIDTH, 3]);
    const results = await session.run({ input: tensor });

    // 3. Decode output: tensor of shape [1, 10, 37]
    const plateOutput = results.plate.data;
    let rawPlate = '';
    let confSum = 0;
    let charCount = 0;
    const charConfidences = [];

    for (let slot = 0; slot < MAX_SLOTS; slot++) {
      let maxProb = -Infinity;
      let maxIdx = -1;
      const offset = slot * 37;
      for (let c = 0; c < 37; c++) {
        const prob = plateOutput[offset + c];
        if (prob > maxProb) {
          maxProb = prob;
          maxIdx = c;
        }
      }
      const char = ALPHABET[maxIdx];
      if (char !== PAD_CHAR) {
        rawPlate += char;
        const conf = Math.max(0, Math.min(1, maxProb));
        confSum += conf;
        charCount++;
        charConfidences.push(Number(conf.toFixed(4)));
      }
    }

    const latencyMs = Number((performance.now() - startTime).toFixed(2));
    const avgConfidence = charCount > 0 ? Number((confSum / charCount).toFixed(4)) : 0;

    if (rawPlate.length === 0) {
      return {
        success: false,
        plate: null,
        rawText: '',
        confidence: 0,
        confidencePercent: 0,
        charConfidences: [],
        latencyMs,
        status: 'empty',
      };
    }

    return {
      success: true,
      plate: rawPlate,
      rawText: rawPlate,
      confidence: avgConfidence,
      confidencePercent: Number((avgConfidence * 100).toFixed(1)),
      charConfidences,
      latencyMs,
      status: 'success',
    };
  } catch (err) {
    const latencyMs = Number((performance.now() - startTime).toFixed(2));
    return {
      success: false,
      error: err.message,
      plate: null,
      rawText: '',
      confidence: 0,
      confidencePercent: 0,
      charConfidences: [],
      latencyMs,
      status: 'inference_failed',
    };
  }
}

/**
 * Shut down the cached session and release ONNX resources.
 */
async function shutdownNeuralOcr() {
  for (const [modelPath, sessionPromise] of sessions.entries()) {
    try {
      const session = await sessionPromise;
      if (session && typeof session.release === 'function') {
        await session.release();
      }
    } catch {
      // ignore
    }
  }
  sessions.clear();
}

module.exports = {
  recognizePlateNeural,
  isNeuralOcrAvailable,
  shutdownNeuralOcr,
  DEFAULT_MODEL_PATH,
};
