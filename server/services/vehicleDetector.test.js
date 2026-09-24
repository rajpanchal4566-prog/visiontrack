const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const {
  detectVehicles,
  decodeOutput,
  normalizeVendorVehicleType,
  compareVendorType,
} = require('./vehicleDetector');

function fakePreparation() {
  return {
    metadata: { width: 640, height: 480 },
    scale: 1,
    padX: 0,
    padY: 0,
  };
}

function fakeOutput(label, confidence = 0.94) {
  const data = new Float32Array(84);
  const classIds = { bicycle: 1, car: 2, motorcycle: 3, bus: 5, truck: 7 };
  data[0] = 320;
  data[1] = 240;
  data[2] = 400;
  data[3] = 240;
  data[4 + classIds[label]] = confidence;
  return { dims: [1, 1, 84], data };
}

function fakeChannelFirstOutput(label, confidence = 0.94) {
  const data = new Float32Array(84);
  const classIds = { bicycle: 1, car: 2, motorcycle: 3, bus: 5, truck: 7 };
  data[0] = 320;
  data[1] = 240;
  data[2] = 400;
  data[3] = 240;
  data[4 + classIds[label]] = confidence;
  return { dims: [1, 84, 1], data };
}

test('decodes a car detection from a YOLO output', () => {
  const [result] = decodeOutput(fakeOutput('car'), fakePreparation());
  assert.equal(result.vehicle_type, 'car');
  assert.equal(result.vehicle_confidence, 0.94);
  assert.deepEqual(result.vehicle_bbox, { x: 120, y: 120, width: 400, height: 240 });
});

test('decodes the installed channel-first YOLO output layout', () => {
  const [result] = decodeOutput(fakeChannelFirstOutput('motorcycle'), fakePreparation());
  assert.equal(result.vehicle_type, 'motorcycle');
  assert.equal(result.vehicle_confidence, 0.94);
});

test('decodes motorcycle, bus, and truck classes without inventing confidence', () => {
  for (const label of ['motorcycle', 'bus', 'truck']) {
    const [result] = decodeOutput(fakeOutput(label, 0.81), fakePreparation());
    assert.equal(result.vehicle_type, label);
    assert.equal(result.vehicle_confidence, 0.81);
  }
});

test('normalizes bike aliases for consistency comparison', () => {
  assert.equal(normalizeVendorVehicleType('bike'), 'motorcycle');
  assert.equal(compareVendorType('bike', 'motorcycle'), true);
  assert.equal(compareVendorType('bike', 'car'), false);
});

test('missing image is a non-fatal detector result', async () => {
  const result = await detectVehicles(null);
  assert.equal(result.vehicle_detected, false);
  assert.equal(result.vehicle_confidence, 0);
  assert.equal(result.vehicle_detection_status, 'missing_image');
});

test('invalid image is a non-fatal detector result', async () => {
  const result = await detectVehicles(Buffer.from('not an image'));
  assert.equal(result.vehicle_detected, false);
  assert.equal(result.vehicle_detection_status, 'detection_failed');
});

test('very small image is rejected before model inference', async () => {
  const image = await sharp({
    create: { width: 8, height: 8, channels: 3, background: { r: 0, g: 0, b: 0 } },
  }).png().toBuffer();
  const result = await detectVehicles(image);
  assert.equal(result.vehicle_detected, false);
  assert.equal(result.vehicle_detection_status, 'IMAGE_TOO_SMALL');
});

test('vehicle detector does not trust vendor type when the model is unavailable', async () => {
  const image = await sharp({
    create: { width: 64, height: 64, channels: 3, background: { r: 255, g: 255, b: 255 } },
  }).png().toBuffer();
  const result = await detectVehicles(image, { vendorVehicleType: 'bike' });
  assert.equal(result.vendor_vehicle_type, 'bike');
  assert.equal(result.vehicle_type_match, null);
  assert.equal(result.vehicle_confidence, 0);
});
