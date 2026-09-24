const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const {
  detectHelmet,
  isHelmetModelAvailable,
} = require('./helmetDetector');

test('helmetDetector model availability check', () => {
  assert.equal(isHelmetModelAvailable(), true);
  assert.equal(isHelmetModelAvailable('non_existent.onnx'), false);
});

test('helmetDetector handles empty/null image gracefully', async () => {
  const nullResult = await detectHelmet(null);
  assert.equal(nullResult.success, false);
  assert.equal(nullResult.status, 'invalid_image');

  const emptyResult = await detectHelmet(Buffer.alloc(0));
  assert.equal(emptyResult.success, false);
  assert.equal(emptyResult.status, 'invalid_image');
});

test('helmetDetector processes motorcycle rider image accurately', async () => {
  const riderImagePath = path.join(__dirname, '..', 'uploads', 'detections', '06819970-f563-4346-a534-871310bf19ad.png');
  assert.ok(fs.existsSync(riderImagePath), 'Test rider image should exist');

  const imageBuffer = fs.readFileSync(riderImagePath);
  
  // Warmup call includes model loading
  const warmup = await detectHelmet(imageBuffer, { x: 50, y: 10, width: 250, height: 210 });
  assert.equal(warmup.success, true);

  // Steady-state call
  const result = await detectHelmet(imageBuffer, { x: 50, y: 10, width: 250, height: 210 });

  assert.equal(result.success, true);
  assert.equal(result.status, 'detected');
  assert.equal(result.hasHelmet, true);
  assert.equal(result.violation, false);
  assert.ok(result.helmetCount >= 1, `Expected at least 1 helmet detected, got ${result.helmetCount}`);
  assert.ok(result.confidence >= 0.40, `Confidence should be >= 0.40, got ${result.confidence}`);
  assert.ok(result.latencyMs < 150, `Steady-state inference latency should be < 150ms, got ${result.latencyMs}ms`);
});
