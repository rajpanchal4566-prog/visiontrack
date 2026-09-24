const test = require('node:test');
const assert = require('node:assert/strict');
const {
  detectViolations,
  VehicleSpeedTracker,
  isRidingVehicle,
  bboxIoU,
} = require('./violationDetector');

test('bboxIoU calculates accurate overlap', () => {
  const b1 = { x: 0, y: 0, width: 100, height: 100 };
  const b2 = { x: 50, y: 0, width: 100, height: 100 };
  const iou = bboxIoU(b1, b2);
  assert.equal(Math.round(iou * 100) / 100, 0.33);
});

test('isRidingVehicle associates rider on motorcycle', () => {
  const motorcycle = { x: 100, y: 150, width: 80, height: 120 };
  const rider = { x: 110, y: 80, width: 60, height: 100 };
  assert.equal(isRidingVehicle(rider, motorcycle), true);

  const pedestrian = { x: 300, y: 80, width: 50, height: 100 };
  assert.equal(isRidingVehicle(pedestrian, motorcycle), false);
});

test('VehicleSpeedTracker calculates velocity from frame displacement', () => {
  const tracker = new VehicleSpeedTracker({ pixelsPerMeter: 20 });
  const t0 = 1000;
  tracker.track('car-1', { x: 100, y: 100, width: 100, height: 60 }, t0);

  // Vehicle moves 200 pixels in 1 second (10 meters in 1s = 10 m/s = 36 km/h)
  const t1 = 2000;
  const speed = tracker.track('car-1', { x: 300, y: 100, width: 100, height: 60 }, t1);
  assert.equal(speed, 36);
});

test('detectViolations flags overspeeding when limit is exceeded', async () => {
  const result = await detectViolations({
    vehicle: { detected_vehicle_type: 'car', vehicle_bbox: { x: 100, y: 100, width: 200, height: 100 } },
    speed: 85,
    camera: { speed_limit_kmh: 50 },
  });

  assert.equal(result.flagged, true);
  assert.equal(result.violations.length, 1);
  assert.equal(result.violations[0].code, 'overspeeding');
  assert.equal(result.violations[0].speed, 85);
});

test('detectViolations flags no_seatbelt for unbelted four-wheeler occupant', async () => {
  const result = await detectViolations({
    vehicle: { detected_vehicle_type: 'car', vehicle_bbox: { x: 50, y: 50, width: 250, height: 150 } },
    telemetry: { no_seatbelt: true },
    camera: { speed_limit_kmh: 60 },
  });

  assert.equal(result.flagged, true);
  assert(result.violations.some(v => v.code === 'no_seatbelt'));
});

test('detectViolations flags no_helmet for unhelmeted motorcycle rider', async () => {
  const result = await detectViolations({
    vehicle: { detected_vehicle_type: 'motorcycle', vehicle_bbox: { x: 100, y: 150, width: 80, height: 120 } },
    occupants: [{ vehicle_type: 'person', vehicle_bbox: { x: 110, y: 80, width: 60, height: 100 } }],
    telemetry: { no_helmet: true },
    camera: { speed_limit_kmh: 50 },
  });

  assert.equal(result.flagged, true);
  assert(result.violations.some(v => v.code === 'no_helmet'));
});

test('detectViolations produces clean record when no violations exist', async () => {
  const result = await detectViolations({
    vehicle: { detected_vehicle_type: 'car', vehicle_bbox: { x: 100, y: 100, width: 200, height: 100 } },
    speed: 45,
    camera: { speed_limit_kmh: 50 },
    telemetry: { has_seatbelt: true },
  });

  assert.equal(result.flagged, false);
  assert.equal(result.violations.length, 0);
});

test('detectViolations runs neural helmet detector on motorcycle image buffer', async () => {
  const fs = require('fs');
  const path = require('path');
  const imagePath = path.join(__dirname, '..', 'uploads', 'detections', '06819970-f563-4346-a534-871310bf19ad.png');
  const buffer = fs.readFileSync(imagePath);

  const result = await detectViolations({
    imageBuffer: buffer,
    vehicle: {
      detected_vehicle_type: 'motorcycle',
      vehicle_bbox: { x: 50, y: 10, width: 250, height: 210 },
    },
    occupants: [{ vehicle_type: 'person', vehicle_bbox: { x: 50, y: 10, width: 250, height: 180 } }],
    camera: { speed_limit_kmh: 50, detect_helmet: true },
  });

  // Rider on 06819970 wears a black helmet, so no_helmet should NOT be triggered
  assert.equal(result.violations.some(v => v.code === 'no_helmet'), false);
});

test('detectViolations runs neural seatbelt classifier on car image buffer', async () => {
  const fs = require('fs');
  const path = require('path');
  const imagePath = path.join(__dirname, '..', 'uploads', 'detections', '008e0ef5-ef3c-4eaf-bb62-e8214f3b0e18.png');
  const buffer = fs.readFileSync(imagePath);

  const result = await detectViolations({
    imageBuffer: buffer,
    vehicle: {
      detected_vehicle_type: 'car',
      vehicle_bbox: { x: 20, y: 30, width: 250, height: 140 },
    },
    camera: { speed_limit_kmh: 50, detect_seatbelt: true },
  });

  assert.ok(typeof result.flagged === 'boolean');
  assert.ok(Array.isArray(result.violations));
});

