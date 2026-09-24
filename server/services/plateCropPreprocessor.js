const sharp = require('sharp');

const HORIZONTAL_PADDING_RATIO = 0.22;
const VERTICAL_PADDING_RATIO = 0.14;
const MIN_HORIZONTAL_PAD_PX = 14;
const MIN_VERTICAL_PAD_PX = 6;
const PADDING_RATIO = 0.22;
const MIN_OCR_HEIGHT = 96;
const MAX_OCR_WIDTH = 640;

function finitePositive(value) {
  return Number.isFinite(Number(value)) && Number(value) > 0;
}

function normalizeBox(box) {
  if (!box || !finitePositive(box.width) || !finitePositive(box.height)) return null;
  if (!Number.isFinite(Number(box.x)) || !Number.isFinite(Number(box.y))) return null;
  return {
    x: Math.round(Number(box.x)),
    y: Math.round(Number(box.y)),
    width: Math.round(Number(box.width)),
    height: Math.round(Number(box.height)),
  };
}

/**
 * Preserve the detector box while preparing a padded, OCR-sized crop.
 */
async function preparePlateCrop(imageInput, boundingBox, imageDimensions = null) {
  const originalBbox = normalizeBox(boundingBox);
  if (!originalBbox) return null;

  const metadata = imageDimensions || await sharp(imageInput).metadata();
  const imageWidth = Number(metadata?.width);
  const imageHeight = Number(metadata?.height);
  if (!finitePositive(imageWidth) || !finitePositive(imageHeight)) return null;

  const padH = Math.max(MIN_HORIZONTAL_PAD_PX, Math.round(originalBbox.width * HORIZONTAL_PADDING_RATIO));
  const padV = Math.max(MIN_VERTICAL_PAD_PX, Math.round(originalBbox.height * VERTICAL_PADDING_RATIO));

  const left = Math.max(0, originalBbox.x - padH);
  const top = Math.max(0, originalBbox.y - padV);
  const right = Math.min(imageWidth, originalBbox.x + originalBbox.width + padH);
  const bottom = Math.min(imageHeight, originalBbox.y + originalBbox.height + padV);
  const expandedWidth = right - left;
  const expandedHeight = bottom - top;
  if (expandedWidth < 1 || expandedHeight < 1) return null;

  const paddedCrop = await sharp(imageInput).rotate().extract({
    left,
    top,
    width: expandedWidth,
    height: expandedHeight,
  }).png().toBuffer();

  // Detect yellow commercial plates (taxis, commercial cabs, trucks)
  let isCommercialYellow = false;
  try {
    const stats = await sharp(paddedCrop).stats();
    if (stats && stats.channels && stats.channels.length >= 3) {
      const rMean = stats.channels[0].mean;
      const gMean = stats.channels[1].mean;
      const bMean = stats.channels[2].mean;
      // In yellow plates: R and G are bright, B is significantly lower
      isCommercialYellow = rMean > 110 && gMean > 100 && (((rMean + gMean) / 2) - bMean) > 25;
    }
  } catch {
    isCommercialYellow = false;
  }

  let enhancedPadded = paddedCrop;
  if (isCommercialYellow) {
    try {
      enhancedPadded = await sharp(paddedCrop)
        .clahe({ width: 4, height: 4, maxSlope: 3 })
        .linear(1.15, -10)
        .png()
        .toBuffer();
    } catch {
      enhancedPadded = paddedCrop;
    }
  }

  const scaleFactor = expandedHeight < MIN_OCR_HEIGHT
    ? Math.min(MIN_OCR_HEIGHT / expandedHeight, MAX_OCR_WIDTH / expandedWidth)
    : 1;
  const ocrWidth = Math.max(1, Math.round(expandedWidth * scaleFactor));
  const ocrHeight = Math.max(1, Math.round(expandedHeight * scaleFactor));
  const ocrCrop = scaleFactor > 1
    ? await sharp(enhancedPadded).resize({ width: ocrWidth, height: ocrHeight, kernel: sharp.kernel.lanczos3 }).png().toBuffer()
    : enhancedPadded;

  return {
    originalCrop: await sharp(imageInput).rotate().extract({
      left: Math.max(0, Math.min(imageWidth - 1, originalBbox.x)),
      top: Math.max(0, Math.min(imageHeight - 1, originalBbox.y)),
      width: Math.min(originalBbox.width, imageWidth - Math.max(0, originalBbox.x)),
      height: Math.min(originalBbox.height, imageHeight - Math.max(0, originalBbox.y)),
    }).png().toBuffer(),
    paddedCrop,
    ocrCrop,
    metadata: {
      originalBbox,
      expandedBbox: { x: left, y: top, width: expandedWidth, height: expandedHeight },
      originalWidth: originalBbox.width,
      originalHeight: originalBbox.height,
      expandedWidth,
      expandedHeight,
      ocrCropWidth: ocrWidth,
      ocrCropHeight: ocrHeight,
      scaleFactor: Number(scaleFactor.toFixed(3)),
      paddingApplied: left !== originalBbox.x || top !== originalBbox.y
        || expandedWidth !== originalBbox.width || expandedHeight !== originalBbox.height,
      upscalingApplied: scaleFactor > 1,
    },
  };
}

module.exports = {
  preparePlateCrop,
  HORIZONTAL_PADDING_RATIO,
  VERTICAL_PADDING_RATIO,
  PADDING_RATIO,
  MIN_OCR_HEIGHT,
};
