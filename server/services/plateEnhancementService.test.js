const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const {
  enhanceAndRecognizePlate,
  applyLanczos,
  applySharpening,
  applyContrastNormalization,
  applySuperResolution,
  ENHANCEMENT_CONFIG,
} = require('./plateEnhancementService');

test('applyLanczos resizes image buffer by scale factor', async () => {
  const buf = await sharp({
    create: { width: 100, height: 30, channels: 3, background: { r: 120, g: 120, b: 120 } },
  }).png().toBuffer();

  const upscaled = await applyLanczos(buf, 2.0);
  const meta = await sharp(upscaled).metadata();
  assert.equal(meta.width, 200);
  assert.equal(meta.height, 60);
});

test('applySharpening runs controlled sharpening without error', async () => {
  const buf = await sharp({
    create: { width: 100, height: 30, channels: 3, background: { r: 120, g: 120, b: 120 } },
  }).png().toBuffer();

  const sharpened = await applySharpening(buf, 'CONTROLLED');
  assert.ok(Buffer.isBuffer(sharpened));
  assert.ok(sharpened.length > 0);
});

test('applyContrastNormalization normalizes buffer without error', async () => {
  const buf = await sharp({
    create: { width: 100, height: 30, channels: 3, background: { r: 120, g: 120, b: 120 } },
  }).png().toBuffer();

  const contrasted = await applyContrastNormalization(buf, true);
  assert.ok(Buffer.isBuffer(contrasted));
});

test('applySuperResolution combines upscale, contrast, and sharpening', async () => {
  const buf = await sharp({
    create: { width: 50, height: 20, channels: 3, background: { r: 120, g: 120, b: 120 } },
  }).png().toBuffer();

  const sr = await applySuperResolution(buf, 2.0);
  const meta = await sharp(sr).metadata();
  assert.equal(meta.width, 100);
  assert.equal(meta.height, 40);
});

test('enhanceAndRecognizePlate handles null or invalid buffer gracefully', async () => {
  const result = await enhanceAndRecognizePlate(null);
  assert.equal(result.success, false);
  assert.equal(result.status, 'invalid_input');
  assert.equal(result.isExtremelyLowResolution, true);
});

test('enhanceAndRecognizePlate recognizes standard plate crop with metadata', async () => {
  const testCropPath = path.join(__dirname, '..', '..', 'models', 'neural_ocr', 'test_crop.png');
  if (fs.existsSync(testCropPath)) {
    const cropBuffer = fs.readFileSync(testCropPath);
    const result = await enhanceAndRecognizePlate(cropBuffer);

    assert.equal(result.success, true);
    assert.ok(result.plate && result.plate.length >= 7);
    assert.ok(result.sourceWidth > 0);
    assert.ok(result.sourceHeight > 0);
    assert.ok(['GOOD', 'MEDIUM', 'POOR', 'EXTREME'].includes(result.qualityClass));
    assert.ok(result.enhancementMethod);
  }
});
