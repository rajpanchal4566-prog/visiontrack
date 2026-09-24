// ==============================================================================
// VisionTrack — Plate Image Quality Analyzer
// Feature 2: Objective, deterministic quality assessment of license plate crops
// Uses Sharp-native operations to measure dimensions, luminance, contrast, and edge sharpness.
// ==============================================================================

const sharp = require('sharp');

/**
 * Centralized, documented quality thresholds.
 * Easily tunable based on empirical benchmark performance.
 */
const QUALITY_THRESHOLDS = {
  // Dimensions
  EXTREME_MAX_WIDTH: 50,       // Below 50px width -> severe pixel starvation
  EXTREME_MAX_HEIGHT: 18,      // Below 18px height -> stroke collapse
  POOR_MAX_WIDTH: 80,          // 50-80px width -> marginal stroke resolution
  MEDIUM_MAX_WIDTH: 130,       // 80-130px width -> moderate resolution
  GOOD_MIN_WIDTH: 130,         // 130px+ width -> ideal resolution for CCT-XS

  // Contrast (standard deviation of luminance)
  MIN_USABLE_CONTRAST: 20,     // Stdev < 20 indicates washed out or flat image
  GOOD_CONTRAST: 40,           // Stdev >= 40 indicates crisp character-to-background separation

  // Sharpness (variance of Laplacian filter)
  BLUR_THRESHOLD: 8.0,         // LapVar < 8.0 indicates significant optical/motion blur
  MEDIUM_SHARPNESS: 18.0,      // LapVar in [8.0, 18.0) indicates mild softening
  GOOD_SHARPNESS: 18.0,        // LapVar >= 18.0 indicates sharp character edges

  // Brightness (0-255 luminance scale)
  LOW_LIGHT_MAX: 65,           // Mean luminance < 65 -> dark/underexposed
  OVEREXPOSED_MIN: 215,        // Mean luminance > 215 -> blown out highlights
};

/**
 * 3x3 Laplacian kernel for high-frequency edge/sharpness estimation.
 * Variance of Laplacian response is a standard metric for image focus.
 */
const LAPLACIAN_KERNEL = {
  width: 3,
  height: 3,
  kernel: [
    0,  1,  0,
    1, -4,  1,
    0,  1,  0,
  ],
};

/**
 * Analyze the visual quality of a raw plate crop buffer.
 *
 * @param {Buffer} cropBuffer - Raw image buffer of cropped plate
 * @returns {Promise<{
 *   width: number,
 *   height: number,
 *   aspectRatio: number,
 *   pixelArea: number,
 *   brightness: number,
 *   contrast: number,
 *   sharpness: number,
 *   blurScore: number,
 *   qualityScore: number,
 *   qualityClass: 'GOOD' | 'MEDIUM' | 'POOR' | 'EXTREME',
 *   qualityWarning: string | null,
 *   isExtremelyLowResolution: boolean
 * }>}
 */
async function analyzePlateQuality(cropBuffer) {
  if (!cropBuffer || !Buffer.isBuffer(cropBuffer) || cropBuffer.length === 0) {
    return {
      width: 0,
      height: 0,
      aspectRatio: 0,
      pixelArea: 0,
      brightness: 0,
      contrast: 0,
      sharpness: 0,
      blurScore: 100,
      qualityScore: 0,
      qualityClass: 'EXTREME',
      qualityWarning: 'invalid_image_buffer',
      isExtremelyLowResolution: true,
    };
  }

  let metadata;
  let stats;
  try {
    const img = sharp(cropBuffer);
    metadata = await img.metadata();
    stats = await img.stats();
  } catch (err) {
    return {
      width: 0,
      height: 0,
      aspectRatio: 0,
      pixelArea: 0,
      brightness: 0,
      contrast: 0,
      sharpness: 0,
      blurScore: 100,
      qualityScore: 0,
      qualityClass: 'EXTREME',
      qualityWarning: `metadata_read_failed: ${err.message}`,
      isExtremelyLowResolution: true,
    };
  }

  const width = metadata.width || 0;
  const height = metadata.height || 0;
  const aspectRatio = height > 0 ? Number((width / height).toFixed(2)) : 0;
  const pixelArea = width * height;

  // 1. Calculate luminance (perceived brightness) from RGB means
  const meanR = stats.channels[0]?.mean || 0;
  const meanG = stats.channels[1]?.mean || meanR;
  const meanB = stats.channels[2]?.mean || meanR;
  const brightness = Number((0.299 * meanR + 0.587 * meanG + 0.114 * meanB).toFixed(2));

  // 2. Calculate RMS contrast from RGB standard deviations
  const stdevR = stats.channels[0]?.stdev || 0;
  const stdevG = stats.channels[1]?.stdev || stdevR;
  const stdevB = stats.channels[2]?.stdev || stdevR;
  const contrast = Number((Math.sqrt(0.299 * stdevR * stdevR + 0.587 * stdevG * stdevG + 0.114 * stdevB * stdevB)).toFixed(2));

  // 3. Calculate sharpness via variance of Laplacian
  let sharpness = 0;
  try {
    if (width >= 6 && height >= 6) {
      const laplacianStats = await sharp(cropBuffer)
        .grayscale()
        .convolve(LAPLACIAN_KERNEL)
        .stats();
      sharpness = Number((laplacianStats.channels[0]?.stdev || 0).toFixed(2));
    }
  } catch {
    sharpness = 0;
  }

  // 4. Blur score (0 = crystal clear, 100 = completely blurry)
  const blurScore = Number(Math.max(0, Math.min(100, 100 / (1 + sharpness / 5))).toFixed(2));

  // 5. Composite Quality Score (0 to 100)
  const resFactor = Math.min(1, width / 140) * 40;
  const sharpFactor = Math.min(1, sharpness / 25) * 30;
  const contrastFactor = Math.min(1, contrast / QUALITY_THRESHOLDS.GOOD_CONTRAST) * 20;
  const lightFactor = (brightness >= QUALITY_THRESHOLDS.LOW_LIGHT_MAX && brightness <= QUALITY_THRESHOLDS.OVEREXPOSED_MIN ? 1 : 0.5) * 10;
  const qualityScore = Number((resFactor + sharpFactor + contrastFactor + lightFactor).toFixed(1));

  // 6. Quality Classification
  const isExtremelyLowResolution = width < QUALITY_THRESHOLDS.EXTREME_MAX_WIDTH || height < QUALITY_THRESHOLDS.EXTREME_MAX_HEIGHT;

  let qualityClass = 'GOOD';
  let qualityWarning = null;

  if (isExtremelyLowResolution) {
    qualityClass = 'EXTREME';
    qualityWarning = 'severe_pixel_starvation';
  } else if (
    width < QUALITY_THRESHOLDS.POOR_MAX_WIDTH ||
    sharpness < QUALITY_THRESHOLDS.BLUR_THRESHOLD ||
    contrast < QUALITY_THRESHOLDS.MIN_USABLE_CONTRAST
  ) {
    qualityClass = 'POOR';
    if (sharpness < QUALITY_THRESHOLDS.BLUR_THRESHOLD) qualityWarning = 'motion_or_defocus_blur';
    else if (contrast < QUALITY_THRESHOLDS.MIN_USABLE_CONTRAST) qualityWarning = 'low_contrast';
    else qualityWarning = 'low_resolution';
  } else if (
    width < QUALITY_THRESHOLDS.MEDIUM_MAX_WIDTH ||
    sharpness < QUALITY_THRESHOLDS.MEDIUM_SHARPNESS ||
    contrast < QUALITY_THRESHOLDS.GOOD_CONTRAST
  ) {
    qualityClass = 'MEDIUM';
  } else {
    qualityClass = 'GOOD';
  }

  return {
    width,
    height,
    aspectRatio,
    pixelArea,
    brightness,
    contrast,
    sharpness,
    blurScore,
    qualityScore,
    qualityClass,
    qualityWarning,
    isExtremelyLowResolution,
  };
}

module.exports = {
  analyzePlateQuality,
  QUALITY_THRESHOLDS,
};
