// ==============================================================================
// VisionTrack — Quality-Aware Plate Image Enhancement Pipeline
// Feature 2: Quality-based routing, adaptive Lanczos/SR, controlled sharpening,
// contrast normalization, and safe fallback on top of Feature 1.
// ==============================================================================

const sharp = require('sharp');
const { analyzePlateQuality } = require('./plateQualityAnalyzer');
const { recognizePlateNeuralEnhanced } = require('./indianPlatePostProcessor');
const {
  isIndianPlateFormat,
  isStandardPlateFormat,
  scorePlateCandidate,
  normalizePlateText,
} = require('./plateNormalizer');

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
 * Centralized, configurable enhancement profiles.
 */
const ENHANCEMENT_CONFIG = {
  // Sharpening profiles (conservative to avoid halo / false glyph distortion)
  SHARPENING: {
    MILD: { sigma: 1.0, m1: 0.8, m2: 1.5, x1: 2, y2: 10, y3: 20 },
    CONTROLLED: { sigma: 1.2, m1: 1.0, m2: 2.0, x1: 2, y2: 12, y3: 22 },
  },

  // Contrast linear adjustments
  CONTRAST: {
    MILD_MULTIPLIER: 1.15,
    MILD_OFFSET: -10,
    MODERATE_MULTIPLIER: 1.25,
    MODERATE_OFFSET: -15,
  },

  // Dimensions
  MAX_OUTPUT_WIDTH: 640,
  MAX_OUTPUT_HEIGHT: 320,
};

/**
 * Apply Lanczos3 resizing to a plate crop buffer.
 *
 * @param {Buffer} cropBuffer
 * @param {number} scaleFactor
 * @returns {Promise<Buffer>}
 */
async function applyLanczos(cropBuffer, scaleFactor = 2.0) {
  if (scaleFactor === 1.0) return cropBuffer;
  const metadata = await sharp(cropBuffer).metadata();
  const targetW = Math.min(ENHANCEMENT_CONFIG.MAX_OUTPUT_WIDTH, Math.max(1, Math.round((metadata.width || 100) * scaleFactor)));
  const targetH = Math.min(ENHANCEMENT_CONFIG.MAX_OUTPUT_HEIGHT, Math.max(1, Math.round((metadata.height || 30) * scaleFactor)));

  return await sharp(cropBuffer)
    .resize(targetW, targetH, { fit: 'fill', kernel: 'lanczos3' })
    .png()
    .toBuffer();
}

/**
 * Apply controlled sharpening without creating harsh halos or false character edges.
 *
 * @param {Buffer} cropBuffer
 * @param {'MILD' | 'CONTROLLED'} [profile='MILD']
 * @returns {Promise<Buffer>}
 */
async function applySharpening(cropBuffer, profile = 'MILD') {
  const conf = ENHANCEMENT_CONFIG.SHARPENING[profile] || ENHANCEMENT_CONFIG.SHARPENING.MILD;
  return await sharp(cropBuffer)
    .sharpen(conf)
    .png()
    .toBuffer();
}

/**
 * Apply controlled contrast normalization and linear stretch.
 *
 * @param {Buffer} cropBuffer
 * @param {boolean} [moderate=false]
 * @returns {Promise<Buffer>}
 */
async function applyContrastNormalization(cropBuffer, moderate = false) {
  const mult = moderate ? ENHANCEMENT_CONFIG.CONTRAST.MODERATE_MULTIPLIER : ENHANCEMENT_CONFIG.CONTRAST.MILD_MULTIPLIER;
  const offset = moderate ? ENHANCEMENT_CONFIG.CONTRAST.MODERATE_OFFSET : ENHANCEMENT_CONFIG.CONTRAST.MILD_OFFSET;

  return await sharp(cropBuffer)
    .normalize()
    .linear(mult, offset)
    .png()
    .toBuffer();
}

async function applyBorderTrim(cropBuffer) {
  try {
    const metadata = await sharp(cropBuffer).metadata();
    if (!metadata.width || !metadata.height || metadata.width < 30 || metadata.height < 15) return cropBuffer;
    const insetX = Math.max(1, Math.round(metadata.width * 0.035));
    const insetY = Math.max(1, Math.round(metadata.height * 0.05));
    const width = Math.max(20, metadata.width - insetX * 2);
    const height = Math.max(12, metadata.height - insetY * 2);
    return await sharp(cropBuffer)
      .extract({ left: insetX, top: insetY, width, height })
      .extend({ top: 4, bottom: 4, left: 8, right: 8, background: { r: 255, g: 255, b: 255 } })
      .png()
      .toBuffer();
  } catch {
    return cropBuffer;
  }
}

/**
 * Apply quality-aware super-resolution (adaptive Lanczos3 + unsharp mask + contrast normalize).
 * Pluggable architecture: falls back gracefully to high-quality Lanczos if needed.
 *
 * @param {Buffer} cropBuffer
 * @param {number} [scaleFactor=2.0]
 * @returns {Promise<Buffer>}
 */
async function applySuperResolution(cropBuffer, scaleFactor = 2.0) {
  try {
    const upscaled = await applyLanczos(cropBuffer, scaleFactor);
    const contrasted = await applyContrastNormalization(upscaled, false);
    return await applySharpening(contrasted, 'CONTROLLED');
  } catch {
    // Graceful fallback to Lanczos
    try {
      return await applyLanczos(cropBuffer, scaleFactor);
    } catch {
      return cropBuffer;
    }
  }
}

/**
 * Main Quality-Aware Plate Enhancement Pipeline.
 *
 * Routes crops based on objective quality analysis:
 * - GOOD: 1 candidate (Original / mild Lanczos if small)
 * - MEDIUM: up to 2 candidates (Original, Contrast+Sharpen)
 * - POOR: up to 3 candidates (Original, Contrast+Sharpen, SR)
 * - EXTREME: up to 3 candidates with low-quality warning preservation
 *
 * Safe Fallback: Compares all candidates against original crop baseline.
 * Accepts enhanced candidate ONLY if validation score strictly improves.
 *
 * @param {Buffer} cropBuffer
 * @param {object} [options={}]
 * @returns {Promise<{
 *   success: boolean,
 *   plate: string|null,
 *   rawText: string,
 *   ocrConfidence: number,
 *   imageQualityScore: number,
 *   qualityClass: 'GOOD' | 'MEDIUM' | 'POOR' | 'EXTREME',
 *   qualityWarning: string|null,
 *   enhancementMethod: string,
 *   scaleFactor: number,
 *   sourceWidth: number,
 *   sourceHeight: number,
 *   isExtremelyLowResolution: boolean,
 *   latencyMs: number,
 *   status: string
 * }>}
 */
async function enhanceAndRecognizePlate(cropBuffer, options = {}) {
  const startTime = performance.now();

  if (!cropBuffer || !Buffer.isBuffer(cropBuffer) || cropBuffer.length === 0) {
    return {
      success: false,
      plate: null,
      rawText: '',
      ocrConfidence: 0,
      imageQualityScore: 0,
      qualityClass: 'EXTREME',
      qualityWarning: 'invalid_image_buffer',
      enhancementMethod: 'none',
      scaleFactor: 1.0,
      sourceWidth: 0,
      sourceHeight: 0,
      isExtremelyLowResolution: true,
      latencyMs: 0,
      status: 'invalid_input',
    };
  }

  // 1. Analyze crop quality
  const quality = await analyzePlateQuality(cropBuffer);

  // 2. Candidate 1 (Always Baseline Original Crop)
  let baselineResult;
  try {
    baselineResult = await recognizePlateNeuralEnhanced(cropBuffer);
  } catch (err) {
    return {
      success: false,
      plate: null,
      rawText: '',
      ocrConfidence: 0,
      imageQualityScore: quality.qualityScore,
      qualityClass: quality.qualityClass,
      qualityWarning: quality.qualityWarning,
      enhancementMethod: 'none',
      scaleFactor: 1.0,
      sourceWidth: quality.width,
      sourceHeight: quality.height,
      isExtremelyLowResolution: quality.isExtremelyLowResolution,
      latencyMs: Number((performance.now() - startTime).toFixed(2)),
      status: 'ocr_failed',
    };
  }

  const baselinePlate = baselineResult.plate || '';
  const baselineScore = scorePlateCandidate(baselinePlate) + scoreStructuralFit(baselinePlate);

  let bestResult = baselineResult;
  let bestScore = baselineScore;
  let chosenMethod = 'original';
  let chosenScale = 1.0;

  // 3. Quality-based routing and variant generation
  const variants = [];

  if (quality.qualityClass === 'GOOD') {
    // Good quality: Keep original; only if width is marginally small (<130px), test 1.3x Lanczos
    if (quality.width < 130) {
      try {
        const upscaled = await applyLanczos(cropBuffer, 1.3);
        variants.push({ buffer: upscaled, method: 'lanczos_1.3x', scale: 1.3 });
      } catch {}
    }
  } else if (quality.qualityClass === 'MEDIUM') {
    // Medium quality: up to 2 candidates
    try {
      const contrastSharpen = await applySharpening(await applyContrastNormalization(cropBuffer, false), 'MILD');
      variants.push({ buffer: contrastSharpen, method: 'contrast_sharpen', scale: 1.0 });
    } catch {}
    if (quality.width < 100) {
      try {
        const upscaled = await applyLanczos(cropBuffer, 1.5);
        variants.push({ buffer: upscaled, method: 'lanczos_1.5x', scale: 1.5 });
      } catch {}
    }
  } else if (quality.qualityClass === 'POOR') {
    // Poor quality: up to 3 candidates
    try {
      const contrastSharpen = await applySharpening(await applyContrastNormalization(cropBuffer, true), 'CONTROLLED');
      variants.push({ buffer: contrastSharpen, method: 'contrast_sharpen', scale: 1.0 });
    } catch {}
    try {
      const sr = await applySuperResolution(cropBuffer, 2.0);
      variants.push({ buffer: sr, method: 'super_resolution_2x', scale: 2.0 });
    } catch {}
  } else if (quality.qualityClass === 'EXTREME') {
    // Extreme quality: severe pixel starvation. Cap dimensions, preserve warning
    try {
      const scale = Math.min(3.0, 150 / Math.max(1, quality.width));
      const sr = await applySuperResolution(cropBuffer, scale);
      variants.push({ buffer: sr, method: `sr_${scale.toFixed(1)}x`, scale });
    } catch {}
    try {
      const highContrast = await applyContrastNormalization(cropBuffer, true);
      variants.push({ buffer: highContrast, method: 'high_contrast', scale: 1.0 });
    } catch {}
  }

  // Always include border_trimmed variant to strip physical frame noise
  try {
    const borderTrimmed = await applyBorderTrim(cropBuffer);
    variants.push({ buffer: borderTrimmed, method: 'border_trimmed', scale: 1.0 });
  } catch {}

  // 4. Evaluate candidates against Feature 1 post-processor
  for (const variant of variants) {
    try {
      const varResult = await recognizePlateNeuralEnhanced(variant.buffer);
      const varPlate = varResult.plate || '';
      const varScore = scorePlateCandidate(varPlate) + scoreStructuralFit(varPlate);

      // Safe Fallback Rule:
      // Accept variant ONLY if:
      // 1. It matches Indian plate format or standard plate format
      // 2. Its score strictly beats baselineScore
      // 3. Or baseline was null/invalid while variant is valid
      const varIsValid = isIndianPlateFormat(varPlate) || isStandardPlateFormat(varPlate);
      const baselineIsValid = isIndianPlateFormat(baselinePlate) || isStandardPlateFormat(baselinePlate);

      if (varIsValid && (!baselineIsValid || varScore > bestScore)) {
        bestResult = varResult;
        bestScore = varScore;
        chosenMethod = variant.method;
        chosenScale = variant.scale;
      }
    } catch {
      // Ignore variant failure, keep baseline
    }
  }

  const totalLatencyMs = Number((performance.now() - startTime).toFixed(2));

  return {
    success: bestResult.success,
    plate: bestResult.plate,
    rawText: bestResult.rawText,
    confidence: bestResult.confidence || 0,
    confidencePercent: Number(((bestResult.confidence || 0) * 100).toFixed(1)),
    ocrConfidence: bestResult.confidence || 0,
    imageQualityScore: quality.qualityScore,
    qualityClass: quality.qualityClass,
    qualityWarning: quality.qualityWarning,
    enhancementMethod: chosenMethod,
    scaleFactor: chosenScale,
    sourceWidth: quality.width,
    sourceHeight: quality.height,
    isExtremelyLowResolution: quality.isExtremelyLowResolution,
    latencyMs: totalLatencyMs,
    status: bestResult.status,
    isTwoLineSplit: bestResult.isTwoLineSplit || false,
    positionalCorrected: bestResult.positionalCorrected || false,
  };
}

module.exports = {
  enhanceAndRecognizePlate,
  applyLanczos,
  applySharpening,
  applyContrastNormalization,
  applySuperResolution,
  ENHANCEMENT_CONFIG,
};
