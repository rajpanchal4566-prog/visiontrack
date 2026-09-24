const assert = require('assert');
const test = require('node:test');
const sharp = require('sharp');
const { preparePlateCrop } = require('./plateCropPreprocessor');

async function image(width, height) {
  return sharp({
    create: { width, height, channels: 3, background: { r: 40, g: 40, b: 40 } },
  }).png().toBuffer();
}

test('expands and upscales a 31x8 plate crop', async () => {
  const result = await preparePlateCrop(await image(200, 120), { x: 80, y: 50, width: 31, height: 8 });
  assert.equal(result.metadata.originalWidth, 31);
  assert.equal(result.metadata.originalHeight, 8);
  assert(result.metadata.expandedWidth > 31);
  assert(result.metadata.expandedHeight > 8);
  assert(result.metadata.ocrCropHeight >= 80);
  assert(result.metadata.upscalingApplied);
});

test('expands and upscales a 42x14 plate crop', async () => {
  const result = await preparePlateCrop(await image(240, 160), { x: 100, y: 60, width: 42, height: 14 });
  assert(result.metadata.expandedWidth > 42);
  assert(result.metadata.expandedHeight > 14);
  assert(result.metadata.ocrCropHeight >= 80);
});

test('clamps a crop at the image edge', async () => {
  const result = await preparePlateCrop(await image(100, 80), { x: 0, y: 0, width: 20, height: 8 });
  assert.equal(result.metadata.expandedBbox.x, 0);
  assert.equal(result.metadata.expandedBbox.y, 0);
  assert(result.metadata.expandedBbox.width <= 100);
  assert(result.metadata.expandedBbox.height <= 80);
});

test('does not enlarge an already large crop', async () => {
  const result = await preparePlateCrop(await image(800, 600), { x: 200, y: 200, width: 300, height: 120 });
  assert.equal(result.metadata.scaleFactor, 1);
  assert.equal(result.metadata.upscalingApplied, false);
});

test('returns null for an invalid bounding box', async () => {
  const result = await preparePlateCrop(await image(100, 80), { x: 10, y: 10, width: 0, height: 8 });
  assert.equal(result, null);
});
