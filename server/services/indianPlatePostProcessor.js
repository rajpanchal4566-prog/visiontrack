// ==============================================================================
// VisionTrack — Indian Plate Positional Post-Processor & Two-Line Preprocessor
// Feature 1: Deterministic positional syntax correction & aspect-ratio splitting
// Does NOT modify or retrain the underlying CCT-XS ONNX model.
// ==============================================================================

const path = require('path');
const sharp = require('sharp');
const { recognizePlateNeural } = require('./neuralPlateOcr');
const { recognizePlateCtc, isCtcOcrAvailable } = require('./ctcPlateOcr');

const INDIA_MODEL_PATH = path.join(__dirname, '..', '..', 'models', 'license-plate-ocr-india-finetuned.onnx');
const BASE_MODEL_PATH = path.join(__dirname, '..', '..', 'models', 'license-plate-ocr.onnx');
const {
  isIndianPlateFormat,
  isStandardPlateFormat,
  scorePlateCandidate,
  normalizePlateText,
  cleanOcrText,
  correctIndianPlate,
  STATE_MAX_RTO,
  LETTER_TO_DIGIT,
  DIGIT_TO_LETTER,
} = require('./plateNormalizer');

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_';
const MAX_SLOTS = 10;
const PAD_CHAR = '_';

function scoreStructuralFit(text) {
  if (!text || text.length < 7 || text.length > 11) return 0;
  let score = 0;
  if (/^[A-Z]{2}/.test(text)) score += 25;
  if (/^[A-Z]{2}\d{1,2}/.test(text)) score += 30;
  if (/^[A-Z]{2}\d{1,2}[A-Z]{1,3}/.test(text)) score += 25;
  if (/\d{4}$/.test(text)) score += 25;
  else if (/\d{1,3}$/.test(text)) score += 15;
  return score;
}

/**
 * Apply deterministic Indian MoRTH positional syntax decoding.
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
 * Helper to decode ONNX output logits into raw plate, confidence, and beam alternatives.
 */
function decodeSessionLogits(outputData) {
  let rawPlate = '';
  let confSum = 0;
  let charCount = 0;
  const charConfidences = [];
  const slotChoices = [];

  for (let slot = 0; slot < MAX_SLOTS; slot++) {
    const probs = [];
    const offset = slot * 37;
    for (let c = 0; c < 37; c++) {
      probs.push({ char: ALPHABET[c], prob: outputData[offset + c] });
    }
    probs.sort((a, b) => b.prob - a.prob);
    slotChoices.push(probs);

    const top = probs[0];
    if (top.char !== PAD_CHAR) {
      rawPlate += top.char;
      const conf = Math.max(0, Math.min(1, top.prob));
      confSum += conf;
      charCount++;
      charConfidences.push(Number(conf.toFixed(4)));
    }
  }

  const avgConfidence = charCount > 0 ? Number((confSum / charCount).toFixed(4)) : 0;
  const candidates = [rawPlate];

  let strIdx = 0;
  for (let slot = 0; slot < MAX_SLOTS; slot++) {
    const top1 = slotChoices[slot][0];
    const top2 = slotChoices[slot][1];
    if (top1.char === PAD_CHAR) continue;
    const curIdx = strIdx++;
    if (top2.char !== PAD_CHAR && top2.prob >= 0.14) {
      candidates.push(rawPlate.slice(0, curIdx) + top2.char + rawPlate.slice(curIdx + 1));
    }
  }

  // Trailing duplicate reduction (e.g. KL01AU5855 -> KL01AU585, KL01CC500 -> KL01CC50)
  if (rawPlate.length >= 8 && rawPlate[rawPlate.length - 1] === rawPlate[rawPlate.length - 2] && /\d{2}$/.test(rawPlate)) {
    candidates.push(rawPlate.slice(0, -1));
  }

  return {
    rawPlate,
    confidence: avgConfidence,
    charConfidences,
    candidates: [...new Set(candidates)],
  };
}

/**
 * Recognize plate characters with dual-model ensemble, beam candidate ranking,
 * strict adaptive TTA, and guarded two-line splitting.
 *
 * @param {Buffer} cropBuffer - Raw image buffer of the plate crop
 * @param {string} [modelPath=null] - Optional path to ONNX model
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

  const { createPlateTensor, getSession } = require('./neuralPlateOcr');

  // Step 1: Initialize ONNX sessions for CTC and dual-model ensemble in parallel
  const ctcPromise = isCtcOcrAvailable()
    ? recognizePlateCtc(cropBuffer, { allowTwoLineSplit: true }).catch(() => null)
    : Promise.resolve(null);

  const [sIndia, sBase, rCtc] = await Promise.all([
    getSession(targetModel),
    getSession(BASE_MODEL_PATH),
    ctcPromise,
  ]);

  if (!sIndia && !sBase && (!rCtc || !rCtc.success)) {
    return {
      success: false,
      plate: null,
      rawText: '',
      confidence: 0,
      confidencePercent: 0,
      charConfidences: [],
      latencyMs: 0,
      status: 'model_unavailable',
    };
  }

  // Step 2: Preprocess crop buffer to ONNX tensor for CCT-XS models (if available)
  let tensor = null;
  if (sIndia || sBase) {
    try {
      tensor = await createPlateTensor(cropBuffer, 0);
    } catch {
      // If sharp preprocessing fails for fixed-slot model, use CTC if available
      if (rCtc && rCtc.success) {
        return {
          ...rCtc,
          latencyMs: Number((performance.now() - startTime).toFixed(2)),
        };
      }
      return await recognizePlateNeural(cropBuffer, targetModel);
    }
  }

  // Step 3: Run CCT-XS inference in parallel
  const sessionRuns = [];
  if (sIndia && tensor) sessionRuns.push(sIndia.run({ input: tensor }));
  if (sBase && sBase !== sIndia && tensor) sessionRuns.push(sBase.run({ input: tensor }));

  const sessionResults = sessionRuns.length > 0 ? await Promise.all(sessionRuns) : [];
  const rIndia = (sIndia && sessionResults[0]) ? decodeSessionLogits(sessionResults[0].plate.data) : null;
  const rBase = (sBase && sessionResults.length > 1) ? decodeSessionLogits(sessionResults[1].plate.data) : null;

  // Step 4: Aggregate beam candidates from all models (CTC + India + Base)
  const allCandidates = [];
  if (rCtc && rCtc.success) {
    for (const c of rCtc.candidates) {
      allCandidates.push({
        text: c,
        conf: rCtc.confidence,
        isBase: c === rCtc.plate,
        model: 'ctc',
        isTwoLine: rCtc.isTwoLineSplit,
      });
    }
  }
  if (rIndia) {
    for (const c of rIndia.candidates) {
      allCandidates.push({ text: c, conf: rIndia.confidence, isBase: c === rIndia.rawPlate, model: 'india' });
    }
  }
  if (rBase) {
    for (const c of rBase.candidates) {
      allCandidates.push({ text: c, conf: rBase.conf || rBase.confidence, isBase: c === rBase.rawPlate, model: 'base' });
    }
  }

  let bestPlate = '';
  let bestRawText = rCtc?.plate || rIndia?.rawPlate || rBase?.rawPlate || '';
  let bestScore = -Infinity;
  let bestCharConfidences = rCtc?.charConfidences || rIndia?.charConfidences || rBase?.charConfidences || [];
  let bestConf = rCtc?.confidence || rIndia?.confidence || rBase?.confidence || 0;
  let isTwoLineSplit = Boolean(rCtc?.isTwoLineSplit);

  for (const cand of allCandidates) {
    const norm = normalizePlateText(cand.text);
    const p = norm.plate || cand.text;
    let score = scorePlateCandidate(p) + scoreStructuralFit(p);

    // Add confidence weight
    score += cand.conf * 20;

    // CTC Model specific weight:
    // Handles arbitrary plate lengths (7, 8, 9, 10, 11) without fixed slot padding
    if (cand.model === 'ctc') {
      score += 15;
      if (p.length !== 10) {
        // High bonus for naturally decoded 7/8/9/11 character plate
        score += 20;
      }
    }

    // Cross-architecture consensus bonus: if CTC and CCT-XS agree
    if (rCtc && rCtc.success && p === rCtc.plate) {
      if ((rIndia && p === rIndia.rawPlate) || (rBase && p === rBase.rawPlate)) {
        score += 45; // High confidence multi-architecture agreement
      }
    } else if (rIndia && rBase && rIndia.rawPlate === rBase.rawPlate && p === rIndia.rawPlate) {
      score += 35;
    }

    // Natural reading bonus
    if (cand.isBase) score += 3;

    if (score > bestScore) {
      bestScore = score;
      bestPlate = p;
      bestRawText = cand.text;
      bestConf = cand.conf;
      if (cand.model === 'ctc' && rCtc) {
        bestCharConfidences = rCtc.charConfidences;
        if (cand.isTwoLine) isTwoLineSplit = true;
      } else if (cand.isBase && cand.model === 'india' && rIndia) {
        bestCharConfidences = rIndia.charConfidences;
      } else if (cand.isBase && cand.model === 'base' && rBase) {
        bestCharConfidences = rBase.charConfidences;
      }
    }
  }

  // Step 5: Strict Adaptive TTA — if winning plate does NOT match Indian format, run mild sharpen
  if (!isIndianPlateFormat(bestPlate)) {
    try {
      const tensorTta = await createPlateTensor(cropBuffer, 0.8);
      const ttaRuns = [];
      if (sIndia) ttaRuns.push(sIndia.run({ input: tensorTta }));
      if (sBase && sBase !== sIndia) ttaRuns.push(sBase.run({ input: tensorTta }));

      const ttaResults = await Promise.all(ttaRuns);
      const rIndiaTta = sIndia ? decodeSessionLogits(ttaResults[0].plate.data) : null;
      const rBaseTta = (sBase && ttaResults.length > 1) ? decodeSessionLogits(ttaResults[1].plate.data) : null;

      const ttaCandidates = [
        ...(rIndiaTta ? rIndiaTta.candidates.map(c => ({ text: c, conf: rIndiaTta.confidence, isBase: c === rIndiaTta.rawPlate })) : []),
        ...(rBaseTta ? rBaseTta.candidates.map(c => ({ text: c, conf: rBaseTta.confidence, isBase: c === rBaseTta.rawPlate })) : []),
      ];

      for (const cand of ttaCandidates) {
        const norm = normalizePlateText(cand.text);
        const p = norm.plate || cand.text;
        let score = scorePlateCandidate(p) + scoreStructuralFit(p) + (cand.conf * 20) - 1.5;
        if (cand.isBase) score += 3;

        if (score > bestScore) {
          bestScore = score;
          bestPlate = p;
          bestRawText = cand.text;
          bestConf = cand.conf;
        }
      }
    } catch {
      // Ignore TTA failure
    }
  }

  // Step 6: Guarded two-line splitting
  // Only attempt two-line splitting if aspect ratio < 2.2 AND single-crop candidate is NOT a valid Indian plate format
  let metadata;
  try {
    metadata = await sharp(cropBuffer).metadata();
  } catch {
    metadata = null;
  }

  const width = metadata?.width || 0;
  const height = metadata?.height || 0;
  const aspectRatio = height > 0 ? width / height : 999;

  if (!isIndianPlateFormat(bestPlate) && aspectRatio < 2.2 && width >= 40 && height >= 30) {
    try {
      const topH = Math.max(1, Math.round(height * 0.55));
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
        const combined1 = `${topText}${botText}`;
        let combined2 = null;
        if (topText.length > 2 && botText.length > 2 && topText.slice(-1) === botText.slice(0, 1)) {
          combined2 = `${topText}${botText.slice(1)}`;
        }

        const candidatesToTest = [combined1, combined2].filter(Boolean);

        for (const cand of candidatesToTest) {
          if (cand.length > 11) continue; // Reject split hallucinations
          const norm = normalizePlateText(cand);
          const finalPlate = norm.plate || cand;
          const score = scorePlateCandidate(finalPlate) + scoreStructuralFit(finalPlate);

          if (isIndianPlateFormat(finalPlate) && score > bestScore) {
            bestScore = score;
            bestPlate = finalPlate;
            bestRawText = cand;
            bestConf = (topRes.confidence + botRes.confidence) / 2;
            bestCharConfidences = [...(topRes.charConfidences || []), ...(botRes.charConfidences || [])];
            isTwoLineSplit = true;
          }
        }
      }
    } catch {
      // Ignore two-line split failure
    }
  }

  const latencyMs = Number((performance.now() - startTime).toFixed(2));
  const confPercent = Number((bestConf * 100).toFixed(1));

  return {
    success: Boolean(bestPlate),
    plate: bestPlate || null,
    rawText: bestRawText,
    confidence: bestConf,
    confidencePercent: confPercent,
    charConfidences: bestCharConfidences,
    latencyMs,
    status: bestPlate ? 'success' : 'empty',
    isTwoLineSplit,
    positionalCorrected: bestPlate !== bestRawText,
  };
}

module.exports = {
  applyIndianPositionalDecoding,
  recognizePlateNeuralEnhanced,
  LETTER_TO_DIGIT,
  DIGIT_TO_LETTER,
};
