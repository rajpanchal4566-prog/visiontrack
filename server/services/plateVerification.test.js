const test = require('node:test');
const assert = require('node:assert/strict');
const { comparablePlate, verifyPlateImage } = require('./plateVerification');

test('comparison normalizes vendor formatting', () => {
  assert.equal(comparablePlate('mp 09-ab-1234'), 'MP09AB1234');
});

test('vendor and AI plates match after normalization', () => {
  const vendor = comparablePlate('MP 09 AB 1234');
  const detected = comparablePlate('MP09AB1234');
  assert.equal(vendor === detected, true);
});

test('vendor and AI plate conflicts remain visible', () => {
  const vendor = comparablePlate('MP09AB1234');
  const detected = comparablePlate('MP09AB1284');
  assert.equal(vendor === detected, false);
});

test('missing image returns a non-fatal verification result', async () => {
  const result = await verifyPlateImage(null, { vendorPlate: 'MP09AB1234' });
  assert.equal(result.success, false);
  assert.equal(result.vendor_plate, 'MP09AB1234');
  assert.equal(result.detected_plate, null);
  assert.equal(result.plate_match, null);
  assert.equal(result.plate_verification_status, 'no_image_data');
});
