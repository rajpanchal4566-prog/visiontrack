const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizePlateText, isIndianPlateFormat } = require('./plateNormalizer');

test('normalizes valid Indian plates with spaces and hyphens', () => {
  assert.equal(normalizePlateText('MP 09 AB 1234').plate, 'MP09AB1234');
  assert.equal(normalizePlateText('MP-09-AB-1234').plate, 'MP09AB1234');
});

test('corrects O/0 and I/1 only in positional roles', () => {
  assert.equal(normalizePlateText('DL0ICA1234').plate, 'DL01CA1234');
  assert.equal(normalizePlateText('MP0GAB1234').plate, 'MP06AB1234');
});

test('corrects S/5 and B/8 only in positional roles', () => {
  assert.equal(normalizePlateText('MH1SXY5678').plate, 'MH15XY5678');
  assert.equal(normalizePlateText('KA0BAB1234').plate, 'KA08AB1234');
});

test('accepts common Indian formats without forcing one length', () => {
  assert.equal(isIndianPlateFormat('MP09A1234'), true);
  assert.equal(isIndianPlateFormat('SK01PC0456'), true);
  assert.equal(isIndianPlateFormat('22BH1234AB'), true);
});

test('rejects random OCR text instead of manufacturing a plate', () => {
  assert.equal(normalizePlateText('EYDREES').plate, null);
  assert.equal(normalizePlateText('this is not a plate').plate, null);
});

test('keeps raw candidate evidence for multiple OCR lines and selects a valid plate', () => {
  const result = normalizePlateText('noise\nSK01PC0456\nnoise');
  assert.equal(result.plate, 'SK01PC0456');
});

test('does not hardcode the observed malformed regression string', () => {
  const result = normalizePlateText('LSK01PC04RE');
  assert.notEqual(result.plate, 'SK01PC0456');
});

test('rejects plates with invalid Indian state codes like AM11AY9', () => {
  assert.equal(normalizePlateText('AM11AY9').plate, null);
  assert.equal(normalizePlateText('ZZ12AB1234').plate, null);
  assert.equal(normalizePlateText('QQ09CD5678').plate, null);
});
