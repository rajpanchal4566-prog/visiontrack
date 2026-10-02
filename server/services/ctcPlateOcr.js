// ==============================================================================
// VisionTrack — CTC-Based Neural Plate OCR Service
// Connectionist Temporal Classification (CTC) recognizer using PP-OCRv5/CRNN
// Replaces fixed-slot (10-char) models to naturally handle variable-length plates
// (7, 8, 9, 10, 11 chars), dynamic aspect ratios, and embossed lettering.
// ==============================================================================

const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const ort = require('onnxruntime-node');

const DEFAULT_MODEL_PATH = path.join(__dirname, '..', '..', 'models', 'ctc_ocr', 'paddleocr_v5_en_rec.onnx');
const DEFAULT_DICT_PATH = path.join(__dirname, '..', '..', 'models', 'ctc_ocr', 'dict.txt');

const TARGET_HEIGHT = 48;
const MIN_WIDTH = 48;
const MAX_WIDTH = 960;
const WIDTH_STRIDE = 32;

const sessions = new Map();
let characterDict = null;

/**
 * Load character dictionary mapping.
 * Index 0 is CTC Blank.
 * Indices 1 .. dict.length map to dict[i - 1].
 */
function getCharacterDict(dictPath = null) {
  if (characterDict) return characterDict;
  const targetPath = dictPath || process.env.CTC_OCR_DICT_PATH || DEFAULT_DICT_PATH;
  const resolved = path.resolve(targetPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`CTC character dictionary not found at ${resolved}`);
  }
  const lines = fs.readFileSync(resolved, 'utf8').split(/\r?\n/);
  characterDict = lines;
  return characterDict;
}

function getActiveModelPath(modelPath) {
  return modelPath || process.env.CTC_OCR_MODEL_PATH || DEFAULT_MODEL_PATH;
}

/**
 * Lazily initialize or retrieve the cached ONNX Runtime session for the CTC model.
 */
async function getCtcSession(modelPath = null) {
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
 * Check if the CTC OCR model file is present on disk.
 */
function isCtcOcrAvailable(modelPath = null) {
  const targetPath = getActiveModelPath(modelPath);
  return fs.existsSync(path.resolve(targetPath));
}

/**
 * Preprocess an image crop buffer into an ONNX tensor matching CTC input [1, 3, 48, dynamic_width].
 *
 * @param {Buffer} cropBuffer
 * @param {object} [options]
 * @param {number} [options.sharpenSigma=0]
 * @returns {Promise<{ tensor: ort.Tensor, width: number, height: number }>}
 */
async function createCtcTensor(cropBuffer, options = {}) {
  const { sharpenSigma = 0 } = options;

  let pipeline = sharp(cropBuffer).flatten({ background: { r: 255, g: 255, b: 255 } });
  if (sharpenSigma > 0) {
    pipeline = pipeline.sharpen({ sigma: sharpenSigma });
  }

  const meta = await pipeline.metadata();
  const srcW = Math.max(1, meta.width || 128);
  const srcH = Math.max(1, meta.height || 48);

  // Dynamic width: maintain aspect ratio scaled to target height 48, aligned to multiple of 32
  let targetW = Math.round((srcW * (TARGET_HEIGHT / srcH)) / WIDTH_STRIDE) * WIDTH_STRIDE;
  targetW = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, targetW || 320));

  const { data: rawBuffer, info } = await pipeline
    .resize(targetW, TARGET_HEIGHT, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const planeSize = TARGET_HEIGHT * targetW;
  const float32Data = new Float32Array(3 * planeSize);

  // Channel-first (CHW) planar arrangement with PaddleOCR normalization: (pixel / 255.0 - 0.5) / 0.5
  for (let h = 0; h < TARGET_HEIGHT; h++) {
    for (let w = 0; w < targetW; w++) {
      const srcIdx = (h * targetW + w) * info.channels;
      const dstIdx = h * targetW + w;

      const r = rawBuffer[srcIdx];
      const g = rawBuffer[srcIdx + 1];
      const b = rawBuffer[srcIdx + 2];

      float32Data[dstIdx] = r / 127.5 - 1.0;
      float32Data[planeSize + dstIdx] = g / 127.5 - 1.0;
      float32Data[2 * planeSize + dstIdx] = b / 127.5 - 1.0;
    }
  }

  const tensor = new ort.Tensor('float32', float32Data, [1, 3, TARGET_HEIGHT, targetW]);
  return { tensor, width: targetW, height: TARGET_HEIGHT };
}

/**
 * Decode CTC logits using greedy decoding with blank removal, repeat collapsing,
 * and beam candidate generation.
 *
 * @param {Float32Array} rawData - Model output logits
 * @param {number[]} dims - [batch, seqLen, numClasses]
 * @param {string[]} dict - Character dictionary
 * @returns {{
 *   rawPlate: string,
 *   confidence: number,
 *   charConfidences: number[],
 *   candidates: string[]
 * }}
 */
function decodeCtcLogits(rawData, dims, dict) {
  const [, seqLen, numClasses] = dims;

  let prevTokenIdx = -1;
  let rawPlate = '';
  const charConfidences = [];
  const emittedSlots = []; // store emitted character info for beam search

  for (let s = 0; s < seqLen; s++) {
    const offset = s * numClasses;

    // Fast top-2 argmax
    let maxVal = -Infinity;
    let maxIdx = -1;
    let secondVal = -Infinity;
    let secondIdx = -1;

    for (let c = 0; c < numClasses; c++) {
      const val = rawData[offset + c];
      if (val > maxVal) {
        secondVal = maxVal;
        secondIdx = maxIdx;
        maxVal = val;
        maxIdx = c;
      } else if (val > secondVal) {
        secondVal = val;
        secondIdx = c;
      }
    }

    // CTC Rule: 0 is blank, collapse consecutive identical tokens
    if (maxIdx !== 0 && maxIdx !== prevTokenIdx) {
      if (maxIdx > 0 && maxIdx <= dict.length) {
        const char = dict[maxIdx - 1];
        if (char && char.trim() !== '') {
          rawPlate += char;
          const conf = Math.max(0, Math.min(1, maxVal));
          charConfidences.push(Number(conf.toFixed(4)));

          const secondChar = (secondIdx > 0 && secondIdx <= dict.length) ? dict[secondIdx - 1] : null;
          emittedSlots.push({
            char,
            maxVal,
            secondChar: (secondChar && secondChar.trim() !== '') ? secondChar : null,
            secondVal,
          });
        }
      }
    }
    prevTokenIdx = maxIdx;
  }

  const avgConfidence = charConfidences.length > 0
    ? Number((charConfidences.reduce((a, b) => a + b, 0) / charConfidences.length).toFixed(4))
    : 0;

  // Generate beam candidates for slots with close runner-ups
  const candidates = [rawPlate];
  if (rawPlate.length > 0) {
    for (let i = 0; i < emittedSlots.length; i++) {
      const slot = emittedSlots[i];
      if (slot.secondChar && slot.secondVal >= 0.15 && slot.secondVal >= slot.maxVal * 0.4) {
        const alt = rawPlate.slice(0, i) + slot.secondChar + rawPlate.slice(i + 1);
        candidates.push(alt);
      }
    }
  }

  return {
    rawPlate,
    confidence: avgConfidence,
    charConfidences,
    candidates: [...new Set(candidates)],
  };
}

/**
 * Recognize plate characters directly from an image crop buffer using CTC Neural OCR.
 *
 * @param {Buffer} cropBuffer - Raw image buffer (JPEG/PNG) of the plate crop.
 * @param {object} [options]
 * @param {string} [options.modelPath]
 * @param {string} [options.dictPath]
 * @param {boolean} [options.allowTwoLineSplit=true]
 * @returns {Promise<{
 *   success: boolean,
 *   plate: string|null,
 *   rawText: string,
 *   confidence: number,
 *   confidencePercent: number,
 *   charConfidences: number[],
 *   candidates: string[],
 *   latencyMs: number,
 *   status: string,
 *   engine: string,
 *   isTwoLineSplit?: boolean
 * }>}
 */
async function recognizePlateCtc(cropBuffer, options = {}) {
  const startTime = performance.now();
  const { modelPath = null, dictPath = null, allowTwoLineSplit = true } = options;

  if (!cropBuffer || !Buffer.isBuffer(cropBuffer) || cropBuffer.length === 0) {
    return {
      success: false,
      error: 'invalid_image',
      plate: null,
      rawText: '',
      confidence: 0,
      confidencePercent: 0,
      charConfidences: [],
      candidates: [],
      latencyMs: 0,
      status: 'invalid_input',
      engine: 'ctc_paddle_v5',
    };
  }

  const session = await getCtcSession(modelPath);
  if (!session) {
    return {
      success: false,
      error: 'model_not_found',
      plate: null,
      rawText: '',
      confidence: 0,
      confidencePercent: 0,
      charConfidences: [],
      candidates: [],
      latencyMs: 0,
      status: 'model_unavailable',
      engine: 'ctc_paddle_v5',
    };
  }

  const dict = getCharacterDict(dictPath);

  try {
    // Check aspect ratio to determine if this is a square/two-line plate
    let meta = null;
    try {
      meta = await sharp(cropBuffer).metadata();
    } catch {
      meta = null;
    }
    const width = meta?.width || 0;
    const height = meta?.height || 0;
    const aspectRatio = height > 0 ? width / height : 999;

    // Single crop forward pass
    const { tensor } = await createCtcTensor(cropBuffer, { sharpenSigma: 0 });
    const runResult = await session.run({ x: tensor });
    const logits = runResult.fetch_name_0;
    const decoded = decodeCtcLogits(logits.data, logits.dims, dict);

    let bestPlate = decoded.rawPlate.toUpperCase().replace(/[^A-Z0-9]/g, '');
    let bestRawText = decoded.rawPlate;
    let bestConf = decoded.confidence;
    let bestCharConfidences = decoded.charConfidences;
    let allCandidates = [...decoded.candidates];
    let isTwoLineSplit = false;

    // Guarded Two-Line Split for square/stacked plates (aspect ratio < 2.2)
    // If the single pass result is short (< 7 chars) or low confidence (< 0.70)
    if (allowTwoLineSplit && aspectRatio < 2.2 && width >= 40 && height >= 30 && (bestPlate.length < 7 || bestConf < 0.70)) {
      try {
        const topH = Math.max(1, Math.round(height * 0.55));
        const botY = Math.round(height * 0.45);
        const botH = Math.max(1, height - botY);

        const [topBuf, botBuf] = await Promise.all([
          sharp(cropBuffer).extract({ left: 0, top: 0, width, height: topH }).png().toBuffer(),
          sharp(cropBuffer).extract({ left: 0, top: botY, width, height: botH }).png().toBuffer(),
        ]);

        const [tensorTop, tensorBot] = await Promise.all([
          createCtcTensor(topBuf),
          createCtcTensor(botBuf),
        ]);

        const [resTop, resBot] = await Promise.all([
          session.run({ x: tensorTop.tensor }),
          session.run({ x: tensorBot.tensor }),
        ]);

        const decTop = decodeCtcLogits(resTop.fetch_name_0.data, resTop.fetch_name_0.dims, dict);
        const decBot = decodeCtcLogits(resBot.fetch_name_0.data, resBot.fetch_name_0.dims, dict);

        const cleanTop = decTop.rawPlate.toUpperCase().replace(/[^A-Z0-9]/g, '');
        const cleanBot = decBot.rawPlate.toUpperCase().replace(/[^A-Z0-9]/g, '');

        if (cleanTop.length >= 2 && cleanBot.length >= 2) {
          // Check overlap (e.g. if bottom line starts with character ending top line)
          let combined = `${cleanTop}${cleanBot}`;
          if (cleanTop.length > 2 && cleanBot.length > 2 && cleanTop.slice(-1) === cleanBot.slice(0, 1)) {
            combined = `${cleanTop}${cleanBot.slice(1)}`;
          }

          if (combined.length >= 7 && combined.length <= 11) {
            const splitAvgConf = (decTop.confidence + decBot.confidence) / 2;
            if (combined.length > bestPlate.length || splitAvgConf > bestConf) {
              bestPlate = combined;
              bestRawText = `${decTop.rawPlate} ${decBot.rawPlate}`;
              bestConf = Number(splitAvgConf.toFixed(4));
              bestCharConfidences = [...decTop.charConfidences, ...decBot.charConfidences];
              allCandidates.push(combined);
              isTwoLineSplit = true;
            }
          }
        }
      } catch {
        // Fall back to single-crop result
      }
    }

    const latencyMs = Number((performance.now() - startTime).toFixed(2));
    const confidencePercent = Number((bestConf * 100).toFixed(1));

    if (!bestPlate || bestPlate.length === 0) {
      return {
        success: false,
        plate: null,
        rawText: '',
        confidence: 0,
        confidencePercent: 0,
        charConfidences: [],
        candidates: [],
        latencyMs,
        status: 'empty',
        engine: 'ctc_paddle_v5',
      };
    }

    return {
      success: true,
      plate: bestPlate,
      rawText: bestRawText,
      confidence: bestConf,
      confidencePercent,
      charConfidences: bestCharConfidences,
      candidates: [...new Set(allCandidates)],
      latencyMs,
      status: 'success',
      engine: 'ctc_paddle_v5',
      isTwoLineSplit,
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
      candidates: [],
      latencyMs,
      status: 'inference_failed',
      engine: 'ctc_paddle_v5',
    };
  }
}

/**
 * Shut down the cached CTC ONNX sessions and release resources.
 */
async function shutdownCtcOcr() {
  for (const [, sessionPromise] of sessions.entries()) {
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
  characterDict = null;
}

module.exports = {
  recognizePlateCtc,
  isCtcOcrAvailable,
  shutdownCtcOcr,
  createCtcTensor,
  getCtcSession,
  getCharacterDict,
  decodeCtcLogits,
  DEFAULT_MODEL_PATH,
  DEFAULT_DICT_PATH,
};
