// ==============================================================================
// VisionTrack — Indian Plate Positional Post-Processor & Two-Line Preprocessor
// Feature 1: Deterministic positional syntax correction & aspect-ratio splitting
// Does NOT modify or retrain the underlying CCT-XS ONNX model.
// ==============================================================================

const path = require('path');
const sharp = require('sharp');
const { recognizePlateNeural } = require('./neuralPlateOcr');

const INDIA_MODEL_PATH = path.join(__dirname, '..', '..', 'models', 'license-plate-ocr-india-finetuned.onnx');
const {
  isIndianPlateFormat,
  isStandardPlateFormat,
  scorePlateCandidate,
  normalizePlateText,
  cleanOcrText,
  correctIndianPlate,
  LETTER_TO_DIGIT,
  DIGIT_TO_LETTER,
} = require('./plateNormalizer');

const INDIAN_STATE_CODES = new Set([
  'AN', 'AP', 'AR', 'AS', 'BR', 'CH', 'CG', 'DD', 'DL', 'DN', 'GA', 'GJ',
  'HP', 'HR', 'JH', 'JK', 'KA', 'KL', 'LA', 'LD', 'MH', 'ML', 'MN', 'MP',
  'MZ', 'NL', 'OD', 'OR', 'PB', 'PY', 'RJ', 'SK', 'TN', 'TR', 'TS', 'UA',
  'UK', 'UP', 'WB',
]);

function scoreStructuralFit(text) {
  if (!text || text.length < 8 || text.length > 11) return 0;
  let score = 0;
  if (/^[A-Z]{2}/.test(text)) score += 25;
  if (/^[A-Z]{2}\d{2}/.test(text)) score += 30;
  if (/^[A-Z]{2}\d{2}[A-Z]{1,3}/.test(text)) score += 25;
  if (/\d{1,4}$/.test(text)) score += 20;
  return score;
}

/**
 * Apply deterministic Indian MoRTH positional syntax decoding.
 * Positions in standard Indian format (XX 00 XX 0000):
 *   1-2: Letters A-Z (State code)
 *   3-4: Digits 0-9 (RTO code)
 *   5-6: Letters A-Z (Series)
 *   7-10: Digits 0-9 (Number)
 *
 * @param {string} rawPlate - Raw plate string from OCR
 * @param {number} [confidence=0] - OCR confidence score
 * @returns {{ plate: string, corrected: boolean, corrections: string[], confidence: number }}
 */
function applyIndianPositionalDecoding(rawPlate, confidence = 0) {
  if (!rawPlate || typeof rawPlate !== 'string') {
    return { plate: '', corrected: false, corrections: [], confidence: 0 };
  }

  const clean = cleanOcrText(rawPlate);
  if (clean.length < 6 || clean.length > 12) {
    return { plate: clean, corrected: false, corrections: [], confidence };
  }

  const corrected = correctIndianPlate(clean);
  const isDiff = Boolean(corrected && corrected !== clean);

  return {
    plate: corrected || clean,
    corrected: isDiff,
    corrections: isDiff ? [`positional_decoding: ${clean} -> ${corrected}`] : [],
    confidence,
  };
}

/**
 * Recognize plate characters with two-line preprocessor and positional post-processor.
 *
 * @param {Buffer} cropBuffer - Raw image buffer of the plate crop
 * @param {string} [modelPath=null] - Optional path to ONNX model (defaults to India fine-tuned)
 * @returns {Promise<{
 *   success: boolean,
 *   plate: string|null,
 *   rawText: string,
 *   confidence: number,
 *   confidencePercent: number,
 *   charConfidences: number[],
 *   latencyMs: number,
 *   status: string,
 *   isTwoLineSplit?: boolean,
 *   positionalCorrected?: boolean
 * }>}
 */
async function recognizePlateNeuralEnhanced(cropBuffer, modelPath = null) {
  const targetModel = modelPath || INDIA_MODEL_PATH;
  const startTime = performance.now();
  if (!cropBuffer || !Buffer.isBuffer(cropBuffer) || cropBuffer.length === 0) {
    return {
      success: false,
      plate: null,
      rawText: '',
      confidence: 0,
      confidencePercent: 0,
      charConfidences: [],
      latencyMs: 0,
      status: 'invalid_input',
    };
  }

  let metadata;
  try {
    metadata = await sharp(cropBuffer).metadata();
  } catch (err) {
    // If sharp fails to read metadata, fall back directly to standard neural OCR
    return await recognizePlateNeural(cropBuffer, targetModel);
  }

  const width = metadata.width || 0;
  const height = metadata.height || 0;
  const aspectRatio = height > 0 ? width / height : 999;

  // Step 1: Run standard CCT-XS on the original crop
  const singleResult = await recognizePlateNeural(cropBuffer, targetModel);
  const singleRaw = singleResult.plate || '';
  const singlePos = applyIndianPositionalDecoding(singleRaw, singleResult.confidence);
  const singleCandidate = singlePos.plate || singleRaw;
  const singleNorm = normalizePlateText(singleCandidate);
  const singleFinal = singleNorm.plate || singleCandidate;
  const singleScore = scorePlateCandidate(singleFinal) + scoreStructuralFit(singleFinal);

  // Step 2: If aspect ratio < 2.2, test two-line splitting
  let bestResult = {
    ...singleResult,
    plate: singleFinal,
    rawText: singleRaw,
    positionalCorrected: singlePos.corrected,
    isTwoLineSplit: false,
  };
  let bestScore = singleScore;

  if (aspectRatio < 2.2 && width >= 40 && height >= 30) {
    try {
      // Top half: top 0% to 55%
      const topH = Math.max(1, Math.round(height * 0.55));
      // Bottom half: top 45% to 100%
      const botY = Math.round(height * 0.45);
      const botH = Math.max(1, height - botY);

      const [topBuffer, botBuffer] = await Promise.all([
        sharp(cropBuffer).extract({ left: 0, top: 0, width, height: topH }).png().toBuffer(),
        sharp(cropBuffer).extract({ left: 0, top: botY, width, height: botH }).png().toBuffer(),
      ]);

      const [topRes, botRes] = await Promise.all([
        recognizePlateNeural(topBuffer, targetModel),
        recognizePlateNeural(botBuffer, targetModel),
      ]);

      const topText = cleanOcrText(topRes.plate || '');
      const botText = cleanOcrText(botRes.plate || '');

      if (topText.length >= 2 && botText.length >= 2) {
        // Form combined candidates:
        // Candidate 1: Direct concatenation top + bot
        const combined1 = `${topText}${botText}`;
        // Candidate 2: If top ends with same char that bot starts with (e.g. series overlap)
        let combined2 = null;
        if (topText.length > 2 && botText.length > 2 && topText.slice(-1) === botText.slice(0, 1)) {
          combined2 = `${topText}${botText.slice(1)}`;
        }

        const candidatesToTest = [combined1, combined2].filter(Boolean);

        for (const cand of candidatesToTest) {
          const pos = applyIndianPositionalDecoding(cand, (topRes.confidence + botRes.confidence) / 2);
          const candText = pos.plate || cand;
          const norm = normalizePlateText(candText);
          const finalPlate = norm.plate || candText;
          const score = scorePlateCandidate(finalPlate) + scoreStructuralFit(finalPlate);

          // Only accept split if it matches Indian format or scores significantly higher
          if ((isIndianPlateFormat(finalPlate) || isStandardPlateFormat(finalPlate)) && score > bestScore) {
            bestScore = score;
            const avgConf = (topRes.confidence + botRes.confidence) / 2;
            bestResult = {
              success: true,
              plate: finalPlate,
              rawText: cand,
              confidence: avgConf,
              confidencePercent: Number((avgConf * 100).toFixed(1)),
              charConfidences: [...(topRes.charConfidences || []), ...(botRes.charConfidences || [])],
              latencyMs: Number((performance.now() - startTime).toFixed(2)),
              status: 'success',
              isTwoLineSplit: true,
              positionalCorrected: pos.corrected,
            };
          }
        }
      }
    } catch {
      // If two-line splitting fails, safely preserve singleResult
    }
  }

  bestResult.latencyMs = Number((performance.now() - startTime).toFixed(2));
  return bestResult;
}

module.exports = {
  applyIndianPositionalDecoding,
  recognizePlateNeuralEnhanced,
  LETTER_TO_DIGIT,
  DIGIT_TO_LETTER,
};
