const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const { analyzePlateQuality, QUALITY_THRESHOLDS } = require('./plateQualityAnalyzer');

test('analyzePlateQuality handles null or invalid buffer gracefully', async () => {
  const result = await analyzePlateQuality(null);
  assert.equal(result.qualityClass, 'EXTREME');
  assert.equal(result.isExtremelyLowResolution, true);
  assert.equal(result.width, 0);
});

test('analyzePlateQuality classifies extremely small image (<50px) as EXTREME with warning', async () => {
  // Create a 40x15 test image
  const smallBuf = await sharp({
    create: {
      width: 40,
      height: 15,
      channels: 3,
      background: { r: 200, g: 200, b: 200 },
    },
  }).png().toBuffer();

  const result = await analyzePlateQuality(smallBuf);
  assert.equal(result.width, 40);
  assert.equal(result.height, 15);
  assert.equal(result.qualityClass, 'EXTREME');
  assert.equal(result.isExtremelyLowResolution, true);
  assert.equal(result.qualityWarning, 'severe_pixel_starvation');
});

test('analyzePlateQuality correctly extracts dimensions, contrast, and brightness on standard image', async () => {
  const testCropPath = path.join(__dirname, '..', '..', 'models', 'neural_ocr', 'test_crop.png');
  if (fs.existsSync(testCropPath)) {
    const cropBuffer = fs.readFileSync(testCropPath);
    const result = await analyzePlateQuality(cropBuffer);

    assert.ok(result.width > 0);
    assert.ok(result.height > 0);
    assert.ok(result.aspectRatio > 0);
    assert.ok(result.brightness > 0);
    assert.ok(result.contrast > 0);
    assert.ok(result.qualityScore > 0);
    assert.ok(['GOOD', 'MEDIUM', 'POOR', 'EXTREME'].includes(result.qualityClass));
  }
});

test('QUALITY_THRESHOLDS has documented and valid numbers', () => {
  assert.equal(QUALITY_THRESHOLDS.EXTREME_MAX_WIDTH, 50);
  assert.ok(QUALITY_THRESHOLDS.POOR_MAX_WIDTH > QUALITY_THRESHOLDS.EXTREME_MAX_WIDTH);
  assert.ok(QUALITY_THRESHOLDS.MEDIUM_MAX_WIDTH > QUALITY_THRESHOLDS.POOR_MAX_WIDTH);
});
