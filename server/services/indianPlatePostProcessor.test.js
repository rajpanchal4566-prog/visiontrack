const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const {
  applyIndianPositionalDecoding,
  recognizePlateNeuralEnhanced,
} = require('./indianPlatePostProcessor');

test('applyIndianPositionalDecoding corrects O to 0 in digit slots', () => {
  const result = applyIndianPositionalDecoding('MHO6AW8929');
  assert.equal(result.plate, 'MH06AW8929');
  assert.equal(result.corrected, true);
});

test('applyIndianPositionalDecoding corrects I to 1 in RTO digit slot', () => {
  const result = applyIndianPositionalDecoding('DL0ICA1234');
  assert.equal(result.plate, 'DL01CA1234');
  assert.equal(result.corrected, true);
});

test('applyIndianPositionalDecoding corrects B to 8 in trailing number slot', () => {
  const result = applyIndianPositionalDecoding('MH12JC281B');
  assert.equal(result.plate, 'MH12JC2818');
  assert.equal(result.corrected, true);
});

test('applyIndianPositionalDecoding corrects S to 5 in trailing number slot', () => {
  const result = applyIndianPositionalDecoding('DL13AB123S');
  assert.equal(result.plate, 'DL13AB1235');
  assert.equal(result.corrected, true);
});

test('applyIndianPositionalDecoding corrects Z to 2 in trailing number slot', () => {
  const result = applyIndianPositionalDecoding('RJ27TC053Z');
  assert.equal(result.plate, 'RJ27TC0532');
  assert.equal(result.corrected, true);
});

test('applyIndianPositionalDecoding corrects G to 6 in trailing number slot', () => {
  const result = applyIndianPositionalDecoding('DL12CG664G');
  assert.equal(result.plate, 'DL12CG6646');
  assert.equal(result.corrected, true);
});

test('applyIndianPositionalDecoding corrects 0 to O in state code if valid', () => {
  const result = applyIndianPositionalDecoding('0D02CR4364');
  assert.equal(result.plate, 'OD02CR4364');
  assert.equal(result.corrected, true);
});

test('applyIndianPositionalDecoding does not alter already valid plate', () => {
  const result = applyIndianPositionalDecoding('MH02CR4364');
  assert.equal(result.plate, 'MH02CR4364');
  assert.equal(result.corrected, false);
});

test('applyIndianPositionalDecoding handles 8-character plate KA19TR02', () => {
  const result = applyIndianPositionalDecoding('KA19TR02');
  assert.equal(result.plate, 'KA19TR02');
});

test('recognizePlateNeuralEnhanced handles invalid or empty buffers gracefully', async () => {
  const result = await recognizePlateNeuralEnhanced(null);
  assert.equal(result.success, false);
  assert.equal(result.status, 'invalid_input');
});

test('recognizePlateNeuralEnhanced recognizes standard plate crop', async () => {
  const testCropPath = path.join(__dirname, '..', '..', 'models', 'neural_ocr', 'test_crop.png');
  if (fs.existsSync(testCropPath)) {
    const cropBuffer = fs.readFileSync(testCropPath);
    const result = await recognizePlateNeuralEnhanced(cropBuffer);
    assert.equal(result.success, true);
    assert.ok(result.plate && result.plate.length >= 7);
  }
});
