const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { normalizeDetection } = require('./vendorAdapter');

test('legacy VisionTrack JSON still works', () => {
  const result = normalizeDetection({
    plate: 'MP09AB1234',
    camera_id: 'CAM001',
    confidence: 0.96,
    vehicle_type: 'car',
    vehicle_color: 'white',
    speed: 65,
    timestamp: '2026-09-15T10:30:00Z',
  });

  assert.equal(result.detection.plate, 'MP09AB1234');
  assert.equal(result.detection.camera_id, 'CAM001');
  assert.equal(result.detection.confidence, 0.96);
  assert.equal(result.detection.vehicle_type, 'Sedan');
  assert.equal(result.detection.source_format, 'json');
});

test('camelCase vendor JSON is normalized', () => {
  const result = normalizeDetection({
    licensePlate: 'MP 09 AB 1234',
    deviceId: 'CAM01',
    score: 96,
    vehicleType: 'car',
    vehicleColor: 'white',
    speedKmh: 65,
    captureTime: '2026-09-15T10:30:00Z',
  });

  assert.equal(result.detection.plate, 'MP09AB1234');
  assert.equal(result.detection.camera_id, 'CAM01');
  assert.equal(result.detection.confidence, 0.96);
  assert.equal(result.detection.speed, 65);
  assert.equal(result.detection.timestamp, '2026-09-15T10:30:00Z');
});

test('snake_case vendor JSON is normalized', () => {
  const result = normalizeDetection({
    plate_number: 'MP-09-AB-1234',
    camera_id: 'CAM012',
    confidence: 0.91,
    vehicle_type: 'suv',
    vehicle_color: 'black',
    speed_kmh: 80,
    event_time: '2026-09-15T10:40:00Z',
  });

  assert.equal(result.detection.plate, 'MP09AB1234');
  assert.equal(result.detection.camera_id, 'CAM012');
  assert.equal(result.detection.vehicle_type, 'SUV');
  assert.equal(result.detection.speed, 80);
});

test('nested vendor JSON resolves practical nested fields', () => {
  const result = normalizeDetection({
    device: { id: 'CAM001' },
    vehicle: {
      licensePlate: 'MP09AB1234',
      type: 'car',
      color: 'white',
      speed: 65,
    },
    recognition: { confidence: 96 },
    event: { timestamp: '2026-09-15T10:30:00Z' },
  });

  assert.equal(result.detection.camera_id, 'CAM001');
  assert.equal(result.detection.plate, 'MP09AB1234');
  assert.equal(result.detection.vehicle_type, 'Sedan');
  assert.equal(result.detection.confidence, 0.96);
  assert.equal(result.detection.timestamp, '2026-09-15T10:30:00Z');
});

test('confidence 96 is normalized to 0.96', () => {
  const result = normalizeDetection({ plate: 'MP09AB1234', camera_id: 'CAM001', confidence: 96 });
  assert.equal(result.detection.confidence, 0.96);
});

test('confidence 0.96 stays 0.96', () => {
  const result = normalizeDetection({ plate: 'MP09AB1234', camera_id: 'CAM001', confidence: 0.96 });
  assert.equal(result.detection.confidence, 0.96);
});

test('unknown extra fields are preserved in safe raw payload metadata', () => {
  const payload = {
    licensePlate: 'MP 09 AB 1234',
    deviceId: 'CAM01',
    score: 96,
    unknownVendorField: 'keep-me',
    secret: 'do-not-expose',
  };

  const result = normalizeDetection(payload);
  assert.ok(result.detection.raw_payload);
  assert.match(String(result.detection.raw_payload), /keep-me/);
  assert.doesNotMatch(String(result.detection.raw_payload), /do-not-expose/);
});

test('missing plate remains invalid without crashing', () => {
  const result = normalizeDetection({ camera_id: 'CAM001', confidence: 0.96 });
  assert.equal(result.detection.plate, null);
  assert.equal(result.detection.camera_id, 'CAM001');
});

test('malformed JSON input is rejected without crashing', () => {
  const result = normalizeDetection('not-an-object');
  assert.equal(result.detection.plate, null);
  assert.equal(result.detection.camera_id, null);
});

test('ingest image data is stored as a public upload path', () => {
  const result = normalizeDetection({
    plate: 'MP09AB1234',
    camera_id: 'CAM001',
    image: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  }, { saveImages: true });

  assert.match(result.detection.image_path, /^\/uploads\/detections\//);
  assert.equal(fs.existsSync(require('node:path').join(__dirname, '..', result.detection.image_path.replace(/^\//, ''))), true);
});
