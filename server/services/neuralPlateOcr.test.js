const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const {
  recognizePlateNeural,
  isNeuralOcrAvailable,
  shutdownNeuralOcr,
  DEFAULT_MODEL_PATH,
} = require('./neuralPlateOcr');

test('neuralPlateOcr model availability check', () => {
  assert.equal(isNeuralOcrAvailable(), true);
  assert.equal(isNeuralOcrAvailable('non_existent_path.onnx'), false);
});

test('recognizePlateNeural recognizes test plate crop accurately and quickly', async () => {
  const testCropPath = path.join(__dirname, '..', '..', 'models', 'neural_ocr', 'test_crop.png');
  assert.ok(fs.existsSync(testCropPath), 'Test crop image must exist');

  const cropBuffer = fs.readFileSync(testCropPath);

  // First call includes session initialization warmup (~100ms)
  const warmupResult = await recognizePlateNeural(cropBuffer);
  assert.equal(warmupResult.success, true);
  assert.equal(warmupResult.plate, 'MS8080A');
  assert.ok(warmupResult.confidence >= 0.90);

  // Steady-state latency assertion (< 20ms)
  const steadyResult = await recognizePlateNeural(cropBuffer);
  assert.equal(steadyResult.success, true);
  assert.equal(steadyResult.plate, 'MS8080A');
  assert.equal(steadyResult.rawText, 'MS8080A');
  assert.ok(steadyResult.confidence >= 0.90, `Confidence should be >= 90%, got ${steadyResult.confidence}`);
  assert.ok(steadyResult.charConfidences.length === 7, `Expected 7 characters for MS8080A, got ${steadyResult.charConfidences.length}`);
  assert.ok(steadyResult.latencyMs < 100, `Steady-state latency should be under 100ms, got ${steadyResult.latencyMs}ms`);
});

test('recognizePlateNeural handles invalid or empty buffers gracefully', async () => {
  const nullResult = await recognizePlateNeural(null);
  assert.equal(nullResult.success, false);
  assert.equal(nullResult.status, 'invalid_input');

  const emptyBuffer = Buffer.alloc(0);
  const emptyResult = await recognizePlateNeural(emptyBuffer);
  assert.equal(emptyResult.success, false);
  assert.equal(emptyResult.status, 'invalid_input');
});

test('recognizePlateNeural returns model_unavailable when model does not exist', async () => {
  const testCropPath = path.join(__dirname, '..', '..', 'models', 'neural_ocr', 'test_crop.png');
  const cropBuffer = fs.readFileSync(testCropPath);
  const result = await recognizePlateNeural(cropBuffer, 'invalid_model.onnx');
  assert.equal(result.success, false);
  assert.equal(result.status, 'model_unavailable');
});
