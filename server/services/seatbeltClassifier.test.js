const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const {
  classifySeatbelt,
  isSeatbeltModelAvailable,
} = require('./seatbeltClassifier');

test('seatbeltClassifier model availability check', () => {
  assert.equal(isSeatbeltModelAvailable(), true);
  assert.equal(isSeatbeltModelAvailable('non_existent.onnx'), false);
});

test('seatbeltClassifier handles empty/null image gracefully', async () => {
  const nullResult = await classifySeatbelt(null);
  assert.equal(nullResult.success, false);
  assert.equal(nullResult.status, 'invalid_image');

  const emptyResult = await classifySeatbelt(Buffer.alloc(0));
  assert.equal(emptyResult.success, false);
  assert.equal(emptyResult.status, 'invalid_image');
});

test('seatbeltClassifier classifies vehicle cabin correctly and quickly', async () => {
  const carImagePath = path.join(__dirname, '..', 'uploads', 'detections', '008e0ef5-ef3c-4eaf-bb62-e8214f3b0e18.png');
  assert.ok(fs.existsSync(carImagePath), 'Test car image should exist');

  const imageBuffer = fs.readFileSync(carImagePath);

  // Warmup call includes model loading
  const warmup = await classifySeatbelt(imageBuffer, { x: 20, y: 30, width: 250, height: 140 });
  assert.equal(warmup.success, true);

  // Steady-state call
  const result = await classifySeatbelt(imageBuffer, { x: 20, y: 30, width: 250, height: 140 });

  assert.equal(result.success, true);
  assert.equal(result.status, 'classified');
  assert.ok(['no_seatbelt', 'seat_belt'].includes(result.predictedClass));
  assert.ok(typeof result.probabilities.no_seatbelt === 'number');
  assert.ok(typeof result.probabilities.seat_belt === 'number');
  assert.ok(result.latencyMs < 300, `Steady-state inference latency should be < 300ms, got ${result.latencyMs}ms`);
});
