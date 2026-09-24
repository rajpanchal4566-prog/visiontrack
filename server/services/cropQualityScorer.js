// ============================================
// VisionTrack — Crop Quality Scorer
// Cheap, model-free quality estimation for
// vehicle crops to support deferred OCR.
//
// Uses only signals that are free or near-free:
//   1. Vehicle crop pixel area (larger = closer = more legible)
//   2. Greyscale standard deviation via sharp.stats() (sharpness/contrast proxy)
//   3. Vehicle detector confidence (already computed during YOLO detection)
//
// No plate detection or OCR model inference is performed.
// Typical cost: 1-3ms per crop.
// ============================================
const sharp = require('sharp');

// Reference values for normalization
const MAX_AREA = 80000;        // ~280x280 px — a large, close vehicle crop
const MAX_SHARPNESS = 70;      // greyscale stdev of 70+ indicates sharp, high-contrast image
const MIN_USEFUL_AREA = 1500;  // crops below ~40x40 are too small to contain a readable plate

/**
 * Compute a cheap quality score for a vehicle crop buffer.
 * Higher score = more likely to produce a good OCR result.
 *
 * @param {Buffer} cropBuffer - JPEG/PNG buffer of the vehicle crop
 * @param {number} [vehicleDetectorConf=0.5] - Confidence from the YOLO vehicle detector (0-1)
 * @returns {Promise<{score: number, area: number, width: number, height: number, sharpness: number, detConf: number}>}
 */
async function scoreCropQuality(cropBuffer, vehicleDetectorConf = 0.5) {
  // Single sharp pipeline: greyscale stats gives us both dimensions and stdev
  const greyscale = sharp(cropBuffer).greyscale();
  const [stats, meta] = await Promise.all([
    greyscale.stats(),
    sharp(cropBuffer).metadata(),
  ]);

  const width = meta.width || 0;
  const height = meta.height || 0;
  const area = width * height;
  const sharpness = stats.channels[0]?.stdev || 0;
  const detConf = Math.max(0, Math.min(1, vehicleDetectorConf));

  // Normalize each signal to [0, 1]
  const normalizedArea = Math.min(1, area / MAX_AREA);
  const normalizedSharpness = Math.min(1, sharpness / MAX_SHARPNESS);

  // Weighted combination:
  //   40% vehicle detector confidence — strongest single predictor of a real, well-framed vehicle
  //   35% crop area — larger crops have more plate pixels, directly impacts OCR legibility
  //   25% sharpness — sharp/high-contrast crops are more readable
  const score = detConf * 0.40 + normalizedArea * 0.35 + normalizedSharpness * 0.25;

  return {
    score: Number(score.toFixed(4)),
    area,
    width,
    height,
    sharpness: Number(sharpness.toFixed(2)),
    detConf,
    tooSmall: area < MIN_USEFUL_AREA,
  };
}

module.exports = { scoreCropQuality, MIN_USEFUL_AREA };
