// ============================================================================
// VisionTrack — OCR Service
//
// ACTIVE ENGINE: Model 3 — India Fine-Tuned ONNX + Indian Positional Post-Processor
//   Model: models/license-plate-ocr-india-finetuned.onnx
//   Architecture: Compact Transformer (CCT-XS) fine-tuned on Indian plates
//   Features: Deterministic Indian MoRTH syntax decoding & two-line aspect splitting
//   Latency: ~12 ms on CPU (~82 FPS)
//
// DISABLED ENGINES (No fallback configured — strict single-engine operation):
//   • Tesseract.js v7: DISABLED (no fallback)
//   • PlateRecognizer cloud: DISABLED (no fallback)
// ============================================================================
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const { generatePreprocessingVariants, resolveImageInput } = require('./ocrPreprocessor');
const { detectPlate, shutdownPlateDetector } = require('./plateDetector');
const { normalizePlateText, isIndianPlateFormat, isStandardPlateFormat } = require('./plateNormalizer');
const { preparePlateCrop } = require('./plateCropPreprocessor');
const { recognizePlateNeuralEnhanced } = require('./indianPlatePostProcessor');

const INDIA_MODEL_PATH = path.join(__dirname, '..', '..', 'models', 'license-plate-ocr-india-finetuned.onnx');

function isOcrDebugEnabled() {
  return process.env.DEBUG_OCR === 'true' || process.env.DEBUG === 'true' || process.env.DEBUG === '1';
}
function ocrLog(...args) {
  if (isOcrDebugEnabled()) console.log(...args);
}

// ---------------------------------------------------------------------------
// DISABLED / PARKED ENGINES — kept only for backwards compatibility / diagnostic routes.
// NOT called in the live request path. Fallback is strictly disabled.
// ---------------------------------------------------------------------------
// PlateRecognizer cloud API — kept for /plate-recognizer/test diagnostic route only.
const { recognizeWithPlateRecognizer } = require('./ocrProviders');
// Neural ONNX raw functions & shutdown.
const { isNeuralOcrAvailable, shutdownNeuralOcr } = require('./neuralPlateOcr');
// ocrFusion — kept for diagnostic routes.
const { fuseOcrResults } = require('./ocrFusion'); // eslint-disable-line no-unused-vars

// Tesseract.js loaded lazily
let tesseractModule = null;
let workerPromise = null;
let ocrQueue = Promise.resolve();

/**
 * Lazily import tesseract.js v7.
 */
function getTesseract() {
  if (!tesseractModule) {
    tesseractModule = require('tesseract.js');
  }
  return tesseractModule;
}

function plateDetectionFields(detectionResult) {
  const detections = detectionResult?.detections || [];
  const best = detections[0] || null;
  const directCrop = !best && detectionResult?.directCrop && detectionResult.image;
  return {
    plate_detected: Boolean(detectionResult?.success || detectionResult?.directCrop),
    plate_confidence: best?.confidence || 0,
    plate_bbox: best ? {
      x: best.x,
      y: best.y,
      width: best.width,
      height: best.height,
    } : directCrop ? {
      x: 0,
      y: 0,
      width: detectionResult.image.width,
      height: detectionResult.image.height,
    } : null,
  };
}

function scoreOcrCandidate(result, normalizedPlate, agreementCount, imageMetadata) {
  const ocrConfidence = Math.max(0, Math.min(1, Number(result.confidence || 0) / 100));
  const agreement = Math.min(1, agreementCount / 3);
  const detectorConfidence = Math.max(0, Math.min(1, Number(result.region.confidence || 0)));
  const regionArea = (result.region.width * result.region.height) / Math.max(1, imageMetadata.width * imageMetadata.height);
  const imageQuality = result.region.width >= 40 && result.region.height >= 10 && regionArea > 0.001 ? 1 : 0.35;
  const patternValidity = (isIndianPlateFormat(normalizedPlate) || isStandardPlateFormat(normalizedPlate)) ? 1 : 0;
  // Weighted score: OCR 45%, variant agreement 20%, detector 20%, image quality 10%, pattern 5%.
  return Number((ocrConfidence * 0.45 + agreement * 0.2 + detectorConfidence * 0.2 + imageQuality * 0.1 + patternValidity * 0.05).toFixed(4));
}

/**
 * Run Tesseract OCR on a single image buffer.
 * Uses the top-level recognize() API from Tesseract.js v7.
 *
 * @param {Buffer} imageBuffer - Preprocessed PNG buffer
 * @param {object} [ocrOptions] - Tesseract parameters
 * @returns {Promise<{text: string, confidence: number}>}
 */
async function recognizeImage(imageBuffer, ocrOptions = {}) {
  const t = getTesseract();

  if (!workerPromise) {
    workerPromise = t.createWorker('eng').then(async (worker) => {
      await worker.setParameters({
        preserve_interword_spaces: '0',
      });
      return worker;
    });
  }

  const result = await (ocrQueue = ocrQueue.then(async () => {
    const worker = await workerPromise;
    await worker.setParameters({ tessedit_pageseg_mode: ocrOptions.tessedit_pageseg_mode || '7' });
    return worker.recognize(imageBuffer);
  }));

  return {
    text: (result?.data?.text || '').trim(),
    confidence: result?.data?.confidence ?? 0, // 0-100 scale in Tesseract.js v7
  };
}

/**
 * Resolve an image input from various sources used in the existing codebase.
 * Handles: file paths (local uploads), data URIs, base64 strings, HTTP URLs, Buffers.
 *
 * @param {string|Buffer} imageInput - The image source
 * @returns {Promise<Buffer|string|null>} Resolved image data
 */
async function resolveImageForOcr(imageInput) {
  if (!imageInput) return null;

  // Buffer — use directly
  if (Buffer.isBuffer(imageInput)) return imageInput;

  if (typeof imageInput !== 'string') return null;

  const trimmed = imageInput.trim();
  if (!trimmed) return null;

  // Data URI
  const dataUriMatch = trimmed.match(/^data:image\/[^;]+;base64,(.+)$/i);
  if (dataUriMatch) {
    return Buffer.from(dataUriMatch[1], 'base64');
  }

  // Raw base64
  if (/^[a-z0-9+/\s]+=*$/i.test(trimmed) && trimmed.length > 100) {
    return Buffer.from(trimmed.replace(/\s/g, ''), 'base64');
  }

  // Local file path (from uploads)
  if (trimmed.startsWith('/uploads/') || trimmed.startsWith('uploads/')) {
    const candidates = [
      path.join(__dirname, '..', trimmed.replace(/^\//, '')),
      path.join(__dirname, '..', '..', trimmed.replace(/^\//, '')),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return fs.readFileSync(candidate);
      }
    }
    return null;
  }

  // HTTP URL — download image
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const response = await fetch(trimmed);
      if (!response.ok) return null;
      return Buffer.from(await response.arrayBuffer());
    } catch {
      return null;
    }
  }

  // Absolute file path
  if (fs.existsSync(trimmed)) {
    return fs.readFileSync(trimmed);
  }

  return null;
}

/**
 * Process a license plate image through the OCR pipeline.
 *
 * Pipeline:
 *   1. Resolve image input → Buffer
 *   2. Generate multiple preprocessing variants
 *   3. Run OCR on each variant
 *   4. Select best result (highest confidence with valid plate text)
 *   5. Normalize plate text
 *   6. Return structured result
 *
 * @param {Buffer|string} imageInput - Image as Buffer, base64, data URI, file path, or URL
 * @returns {Promise<object>} OCR result
 */
async function processPlateImage(imageInput, options = {}) {
  const startTime = Date.now();
  const timings = { preprocessing: 0, detection: 0, ocr: 0, normalization: 0, total: 0 };
  ocrLog('[OCR] Request received');

  // Step 1: Resolve image
  let imageData;
  try {
    imageData = await resolveImageForOcr(imageInput);
  } catch (err) {
    console.warn('[OCR_FAILED] Image resolution error:', err.message);
    return makeFailureResult(startTime, 'image_resolution_failed', err.message);
  }

  if (!imageData) {
    console.warn('[OCR_FAILED] No valid image data provided');
    return makeFailureResult(startTime, 'no_image_data', 'Image input could not be resolved');
  }

  const imageSize = Buffer.isBuffer(imageData) ? imageData.length : 'file';
  ocrLog(`[OCR] Image received: ${imageSize} bytes`);

  // Step 2: Detect likely plate regions before any OCR.
  const detectionStart = Date.now();
  let detectionResult;
  try {
    detectionResult = await detectPlate(imageData);
  } catch (err) {
    console.warn('[OCR_FAILED] Plate detector error:', err.code || err.message);
    return makeFailureResult(startTime, err.code || 'detection_failed', err.message, timings);
  }
  timings.detection = Date.now() - detectionStart;

  const metadata = { width: detectionResult.image.width, height: detectionResult.image.height };
  ocrLog(`[OCR] Image dimensions: ${metadata.width}x${metadata.height}`);
  ocrLog(`[OCR] Model plate candidates detected: ${detectionResult.detections.length}`);
  if (!detectionResult.success && !detectionResult.directCrop) {
    return makeFailureResult(startTime, 'NO_PLATE_DETECTED', 'The plate detector found no license plate', timings, metadata);
  }

  const candidates = [];
  const detectorCandidates = detectionResult.detections.map((detection) => ({ ...detection }));
  if (detectionResult.directCrop) {
    detectorCandidates.push({ x: 0, y: 0, width: metadata.width, height: metadata.height, confidence: null, source: 'direct_crop' });
  }
  for (const detection of detectorCandidates) {
    try {
      const prepared = await preparePlateCrop(imageData, detection, metadata);
      if (!prepared) {
        console.warn('[OCR] Invalid plate crop bounds');
        continue;
      }
      candidates.push({
        ...detection,
        x: prepared.metadata.expandedBbox.x,
        y: prepared.metadata.expandedBbox.y,
        width: prepared.metadata.expandedWidth,
        height: prepared.metadata.expandedHeight,
        buffer: prepared.ocrCrop,
        cropMetadata: prepared.metadata,
      });
    } catch (err) {
      console.warn(`[OCR] Failed to crop detector candidate: ${err.message}`);
    }
  }
  if (candidates.length === 0) {
    return makeFailureResult(startTime, 'INVALID_IMAGE', 'Detected plate region could not be cropped', timings, metadata);
  }

  // Step 3: OCR — Primary Engine: Model 3 (India Fine-Tuned ONNX + Indian Positional Post-Processor)
  // Fallback is strictly DISABLED. Tesseract and PlateRecognizer are not called.
  const ocrResults = [];
  const ocrStart = Date.now();
  const candidatesToScan = candidates.slice(0, 2);

  ocrLog('[OCR] Running Model 3: India Fine-Tuned ONNX + Indian Positional Post-Processor');
  for (let candidateIndex = 0; candidateIndex < candidatesToScan.length; candidateIndex += 1) {
    const candidate = candidatesToScan[candidateIndex];
    try {
      const enhancedResult = await recognizePlateNeuralEnhanced(candidate.buffer, INDIA_MODEL_PATH);
      if (enhancedResult && (enhancedResult.plate || enhancedResult.rawText)) {
        const rawText = enhancedResult.rawText || enhancedResult.plate || '';
        const conf = enhancedResult.confidencePercent || (enhancedResult.confidence * 100) || 0;
        ocrResults.push({
          candidateIndex,
          region: candidate,
          engine: 'neural_india_enhanced',
          variantName: enhancedResult.isTwoLineSplit ? 'two_line_split' : 'direct_crop',
          psmMode: 'neural_cct_xs',
          rawText,
          plate: enhancedResult.plate,
          confidence: conf,
          isTwoLineSplit: Boolean(enhancedResult.isTwoLineSplit),
          positionalCorrected: Boolean(enhancedResult.positionalCorrected),
        });
        ocrLog(`[OCR] Candidate ${candidateIndex + 1}: plate="${enhancedResult.plate}" raw="${rawText}" conf=${conf.toFixed(1)}% split=${enhancedResult.isTwoLineSplit}`);

        const quick = normalizePlateText(enhancedResult.plate || rawText);
        const isValid = quick.plate && (isIndianPlateFormat(quick.plate) || isStandardPlateFormat(quick.plate));
        if (isValid && conf >= 30) {
          // Definite plate found, no need to process further candidates
          break;
        }
      }
    } catch (err) {
      console.warn(`[OCR] Candidate ${candidateIndex + 1} Model 3 inference error: ${err.message}`);
    }
  }
  timings.ocr = Date.now() - ocrStart;

  if (ocrResults.length === 0) {
    console.warn('[OCR_FAILED] Model 3 returned empty text from all plate candidates');
    return makeFailureResult(startTime, 'empty_result', 'Model 3 produced no text from any plate candidate', timings, metadata);
  }

  // Step 4: Normalize all results and select the best
  const normalizedResults = [];

  for (const result of ocrResults) {
    const normalizationStart = Date.now();
    const candidateText = result.plate || result.rawText;
    const normalized = normalizePlateText(candidateText);
    timings.normalization += Date.now() - normalizationStart;
    const hasFormat = normalized.plate && (isIndianPlateFormat(normalized.plate) || isStandardPlateFormat(normalized.plate));
    const isHighConfidenceNeural = result.confidence >= 25;
    const effectivePlate = normalized.plate
      || result.plate
      || (isHighConfidenceNeural ? result.rawText?.toUpperCase().replace(/[^A-Z0-9]/g, '') || null : null);
    if (effectivePlate && (hasFormat || isHighConfidenceNeural)) {
      normalizedResults.push({
        ...result,
        plate: effectivePlate,
        corrections: normalized.corrections || [],
        score: result.confidence + (result.region.confidence || 0) * 20,
      });
    }
  }

  const normalizedCounts = normalizedResults.reduce((counts, result) => {
    counts[result.plate] = (counts[result.plate] || 0) + 1;
    return counts;
  }, {});
  normalizedResults.forEach((result) => {
    result.agreementCount = normalizedCounts[result.plate] || 1;
    result.finalScore = scoreOcrCandidate(result, result.plate, result.agreementCount, metadata);
  });
  const acceptedNormalizedResults = normalizedResults.filter((result) =>
    result.finalScore >= 0.25 || (result.plate && (isIndianPlateFormat(result.plate) || isStandardPlateFormat(result.plate))) || (result.confidence >= 35 || normalizedCounts[result.plate] >= 2)
  );

  // Also keep track of the best raw result (for diagnostics even if normalization fails)
  const bestRawResult = ocrResults.reduce((best, current) =>
    current.confidence > best.confidence ? current : best
  , ocrResults[0]);

  ocrLog(`[OCR] Neural raw text (best): "${bestRawResult.rawText}" confidence=${bestRawResult.confidence}`);

  // Step 5: Select best normalized result
  let finalResult;
  if (acceptedNormalizedResults.length > 0) {
    // Sort by confidence descending, prefer longer plates
    acceptedNormalizedResults.sort((a, b) => {
      const confDiff = b.finalScore - a.finalScore;
      if (Math.abs(confDiff) > 0.05) return confDiff;
      return (b.plate?.length || 0) - (a.plate?.length || 0); // prefer longer plates
    });
    finalResult = acceptedNormalizedResults[0];
  }

  // PlateRecognizer cloud API is NOT called here (fallback disabled).
  const processingTimeMs = Date.now() - startTime;

  if (finalResult) {
    const determinedPlate = finalResult.plate;
    ocrLog(`[OCR] Normalized text: "${determinedPlate}"`);
    ocrLog(`[OCR] Final result: SUCCESS (${processingTimeMs}ms)`);

    timings.total = Date.now() - startTime;

    return {
      success: true,
      ...plateDetectionFields(detectionResult),
      plate: determinedPlate,
      plate_source: 'neural_india_enhanced',
      plate_confidence: finalResult.confidence ? finalResult.confidence / 100 : 0.8,
      local_ocr_plate: determinedPlate,
      local_ocr_confidence: finalResult.confidence / 100,
      // PlateRecognizer fields — null while engine is parked
      plate_recognizer_plate: null,
      plate_recognizer_confidence: 0,
      plates_agree: null,
      fusion_decision: 'LOCAL_ONLY',
      candidate_plate: determinedPlate,
      local_raw_text: finalResult.rawText,
      provider_raw_text: null,
      provider_normalized_plate: null,
      fusion_similarity: null,
      plate_recognizer_status: 'DISABLED',
      plate_recognizer_error: null,
      confidence: finalResult.confidence,
      rawText: finalResult.rawText,
      processingTimeMs,
      timings,
      candidateCount: candidates.length,
      candidateRegions: candidates.map(({ buffer, ...region }) => region),
      detectorConfidence: finalResult.region?.confidence != null ? finalResult.region.confidence * 100 : null,
      ocrConfidence: finalResult.confidence,
      finalConfidence: Math.round(finalResult.finalScore * 10000) / 100,
      plateRegion: finalResult.region ? {
        x: finalResult.region.x,
        y: finalResult.region.y,
        width: finalResult.region.width,
        height: finalResult.region.height,
      } : null,
      plateCrop: `data:image/png;base64,${finalResult.region.buffer.toString('base64')}`,
      corrections: finalResult.corrections,
      variantUsed: finalResult.variantName,
      psmUsed: finalResult.psmMode,
      allResults: ocrResults.map(r => ({ variant: r.variantName, psm: r.psmMode, text: r.rawText, confidence: r.confidence })),
      candidates: ocrResults.map(r => ({
        rawText: r.rawText,
        confidence: r.confidence,
        variant: r.variantName,
        psm: r.psmMode,
        plate: normalizedResults.find((item) => item.rawText === r.rawText && item.variantName === r.variantName)?.plate || null,
        finalScore: normalizedResults.find((item) => item.rawText === r.rawText && item.variantName === r.variantName)?.finalScore || 0,
      })),
      preprocessingInfo: metadata,
      cropPreparation: finalResult.region.cropMetadata || null,
      error: null,
      errorDetail: null,
      ocrStatus: 'SUCCESS',
    };
  }

  // No normalized result found, but we have raw OCR text
  ocrLog(`[OCR] Final result: FAILED — no valid plate from raw text "${bestRawResult.rawText}"`);
  timings.total = processingTimeMs;

  return {
    success: false,
    ...plateDetectionFields(detectionResult),
    plate: null,
    plate_source: null,
    plate_confidence: 0,
    local_ocr_plate: null,
    local_ocr_confidence: Math.max(0, Math.min(1, Number(bestRawResult.confidence || 0) / 100)),
    plate_recognizer_plate: null,
    plate_recognizer_confidence: 0,
    plates_agree: null,
    fusion_decision: 'NO_VALID_PLATE',
    candidate_plate: null,
    local_raw_text: bestRawResult.rawText,
    provider_raw_text: null,
    provider_normalized_plate: null,
    fusion_similarity: null,
    plate_recognizer_status: 'DISABLED',
    plate_recognizer_error: null,
    confidence: 0,
    detectorConfidence: bestRawResult.region && bestRawResult.region.confidence !== null
      ? bestRawResult.region.confidence * 100
      : null,
    ocrConfidence: bestRawResult.confidence,
    finalConfidence: 0,
    rawText: bestRawResult.rawText,
    processingTimeMs,
    timings,
    candidateCount: candidates.length,
    candidateRegions: candidates.map(({ buffer, ...region }) => region),
    plateRegion: bestRawResult.region ? {
      x: bestRawResult.region.x,
      y: bestRawResult.region.y,
      width: bestRawResult.region.width,
      height: bestRawResult.region.height,
    } : null,
    plateCrop: bestRawResult.region
      ? `data:image/png;base64,${bestRawResult.region.buffer.toString('base64')}`
      : null,
    corrections: [],
    variantUsed: bestRawResult.variantName,
    psmUsed: bestRawResult.psmMode,
    allResults: ocrResults.map(r => ({ variant: r.variantName, psm: r.psmMode, text: r.rawText, confidence: r.confidence })),
    candidates: ocrResults.map(r => ({ rawText: r.rawText, confidence: r.confidence, variant: r.variantName, psm: r.psmMode, plate: null })),
    preprocessingInfo: metadata,
    cropPreparation: bestRawResult.region?.cropMetadata || null,
    error: 'NO_VALID_PLATE',
    errorDetail: `OCR text "${bestRawResult.rawText}" did not match a license plate pattern`,
    ocrStatus: 'NO_VALID_PLATE',
  };
}

/**
 * Build a standardized failure result.
 */
function makeFailureResult(startTime, error, detail, timings = null, metadata = null) {
  const finalTimings = timings || { preprocessing: 0, detection: 0, ocr: 0, normalization: 0, total: 0 };
  finalTimings.total = Date.now() - startTime;
  return {
    success: false,
    plate_detected: false,
    plate_confidence: 0,
    plate_bbox: null,
    plate: null,
    confidence: 0,
    rawText: '',
    processingTimeMs: Date.now() - startTime,
    timings: finalTimings,
    candidateCount: 0,
    detectorConfidence: null,
    ocrConfidence: 0,
    finalConfidence: 0,
    plateRegion: null,
    plateCrop: null,
    corrections: [],
    variantUsed: null,
    psmUsed: null,
    allResults: [],
    preprocessingInfo: metadata,
    error,
    errorDetail: detail || null,
    ocrStatus: error === 'NO_PLATE_DETECTED' || error === 'empty_result' ? 'NO_VALID_PLATE' : 'FAILED',
  };
}

/**
 * Determine the best image field to use for OCR from a detection payload.
 * Checks fields in priority order matching the existing codebase.
 */
function findOcrImageSource(payload) {
  if (!payload || typeof payload !== 'object') return null;

  const fields = [
    'plate_image', 'plateImage',
    'image', 'image_base64', 'imageBase64',
    'snapshot', 'vehicle_image_url',
    'image_url', 'imageUrl', 'snapshot_url',
    'picture', 'picture_url',
  ];

  for (const field of fields) {
    const value = payload[field];
    if (!value) continue;

    if (typeof value === 'string' && value.trim()) return value.trim();

    if (typeof value === 'object') {
      const nested = value.url || value.uri || value.base64 || value.data || value.path;
      if (nested && typeof nested === 'string' && nested.trim()) return nested.trim();
    }
  }

  return null;
}

/**
 * Shutdown — no-op in v7 top-level API (no persistent worker).
 */
async function shutdownOcr() {
  if (workerPromise) {
    const worker = await workerPromise;
    await worker.terminate();
    workerPromise = null;
    ocrQueue = Promise.resolve();
  }
  await shutdownPlateDetector();
  await shutdownNeuralOcr();
}

module.exports = {
  processPlateImage,
  recognizeImage,
  findOcrImageSource,
  resolveImageForOcr,
  shutdownOcr,
};
