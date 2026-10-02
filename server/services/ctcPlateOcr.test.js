const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const {
  recognizePlateCtc,
  isCtcOcrAvailable,
  shutdownCtcOcr,
  getCharacterDict,
  createCtcTensor,
} = require('./ctcPlateOcr');

test('ctcPlateOcr model and dictionary availability check', () => {
  assert.equal(isCtcOcrAvailable(), true);
  assert.equal(isCtcOcrAvailable('non_existent_path.onnx'), false);

  const dict = getCharacterDict();
  assert.ok(Array.isArray(dict));
  assert.ok(dict.length > 400);
});

test('recognizePlateCtc handles invalid or empty buffers gracefully', async () => {
  const nullResult = await recognizePlateCtc(null);
  assert.equal(nullResult.success, false);
  assert.equal(nullResult.status, 'invalid_input');

  const emptyBuffer = Buffer.alloc(0);
  const emptyResult = await recognizePlateCtc(emptyBuffer);
  assert.equal(emptyResult.success, false);
  assert.equal(emptyResult.status, 'invalid_input');
});

test('recognizePlateCtc returns model_unavailable when model does not exist', async () => {
  const testCropPath = path.join(__dirname, '..', '..', 'models', 'neural_ocr', 'test_crop.png');
  const cropBuffer = fs.readFileSync(testCropPath);
  const result = await recognizePlateCtc(cropBuffer, { modelPath: 'invalid_model.onnx' });
  assert.equal(result.success, false);
  assert.equal(result.status, 'model_unavailable');
});

test('recognizePlateCtc recognizes standard plate crop with dynamic sequence decoding', async () => {
  const testCropPath = path.join(__dirname, '..', '..', 'models', 'neural_ocr', 'test_crop.png');
  assert.ok(fs.existsSync(testCropPath), 'Test crop image must exist');

  const cropBuffer = fs.readFileSync(testCropPath);

  // Warmup
  const warmupResult = await recognizePlateCtc(cropBuffer);
  assert.equal(warmupResult.success, true);
  assert.equal(warmupResult.plate, 'MS8080A');
  assert.ok(warmupResult.confidence >= 0.90);

  // Steady-state latency check
  const steadyResult = await recognizePlateCtc(cropBuffer);
  assert.equal(steadyResult.success, true);
  assert.equal(steadyResult.plate, 'MS8080A');
  assert.equal(steadyResult.rawText, 'MS8080A');
  assert.ok(steadyResult.confidence >= 0.90, `Confidence should be >= 90%, got ${steadyResult.confidence}`);
  assert.equal(steadyResult.plate.length, 7, 'CTC output length must match exactly 7 characters without slot padding');
  assert.ok(steadyResult.latencyMs < 100, `Steady-state latency should be under 100ms, got ${steadyResult.latencyMs}ms`);
});

test('createCtcTensor scales width dynamically to multiples of 32', async () => {
  const testCropPath = path.join(__dirname, '..', '..', 'models', 'neural_ocr', 'test_crop.png');
  const cropBuffer = fs.readFileSync(testCropPath);
  const { tensor, width, height } = await createCtcTensor(cropBuffer);

  assert.equal(height, 48);
  assert.ok(width % 32 === 0, `Width must be multiple of 32, got ${width}`);
  assert.equal(tensor.type, 'float32');
  assert.deepEqual(tensor.dims, [1, 3, 48, width]);
});
