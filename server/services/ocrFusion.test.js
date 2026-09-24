const assert = require('node:assert/strict');
const test = require('node:test');
const { fuseOcrResults } = require('./ocrFusion');

const base = { detectorConfidence: 0.84, cropWidth: 64, cropHeight: 28 };

test('agreement is verified', () => {
  const result = fuseOcrResults({ ...base, localRawText: 'WB02AB2797', localConfidence: 82, providerPlate: 'WB02AB2797', providerConfidence: 0.8 });
  assert.equal(result.decision, 'AGREEMENT_VERIFIED');
  assert.equal(result.plate, 'WB02AB2797');
  assert.equal(result.platesAgree, true);
});

test('valid provider with invalid local text is provider supported', () => {
  const result = fuseOcrResults({ ...base, localRawText: 'CEE', localConfidence: 41, providerPlate: 'WB02AB2797', providerConfidence: 0.729 });
  assert.equal(result.decision, 'PROVIDER_SUPPORTED');
  assert.equal(result.plate, null);
  assert.equal(result.candidatePlate, 'WB02AB2797');
});

test('different valid sources need confirmation', () => {
  const result = fuseOcrResults({ ...base, localRawText: 'WB02AB2797', localConfidence: 75, providerPlate: 'WB02AB2787', providerConfidence: 0.8 });
  assert.equal(result.decision, 'NEEDS_CONFIRMATION');
  assert.equal(result.plate, null);
});

test('both invalid produce no valid plate', () => {
  assert.equal(fuseOcrResults({ ...base, localRawText: 'J', providerPlate: null }).decision, 'NO_VALID_PLATE');
});

test('provider below threshold is rejected', () => {
  const result = fuseOcrResults({ ...base, localRawText: 'CEE', providerPlate: 'WB02AB2797', providerConfidence: 0.6 });
  assert.equal(result.decision, 'REJECTED');
});

test('plausible one-character difference needs confirmation', () => {
  const result = fuseOcrResults({ ...base, localRawText: 'WB02AB2797', providerPlate: 'WB02AB2787', providerConfidence: 0.8 });
  assert.equal(result.decision, 'NEEDS_CONFIRMATION');
  assert(result.similarity >= 0.8);
});
