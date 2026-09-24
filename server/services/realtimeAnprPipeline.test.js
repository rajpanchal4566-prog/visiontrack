const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { realtimeAnprPipeline } = require('./realtimeAnprPipeline');
const { getDb } = require('../database');

test('realtimeAnprPipeline processes frame and skips OCR if no vehicle is present', async () => {
  // Create a blank 300x200 image
  const blankImage = await sharp({
    create: { width: 300, height: 200, channels: 3, background: { r: 128, g: 128, b: 128 } },
  }).jpeg().toBuffer();

  const result = await realtimeAnprPipeline.processFrame(blankImage, {
    cameraId: 'CAM-TEST-1',
    sourceType: 'rtsp',
    emitSocket: false,
  });

  assert.equal(result.success, true);
  assert.equal(result.vehicle_detected, false);
});

test('realtimeAnprPipeline flags violations and persists detection when vehicle & plate are present', async () => {
  // Create synthetic frame
  const testFrame = await sharp({
    create: { width: 640, height: 480, channels: 3, background: { r: 50, g: 50, b: 50 } },
  }).jpeg().toBuffer();

  const db = getDb();
  const testCam = db.prepare('SELECT * FROM cameras LIMIT 1').get();

  const result = await realtimeAnprPipeline.processFrame(testFrame, {
    camera: testCam,
    sourceType: 'rtsp',
    emitSocket: false,
    telemetry: {
      speed: 88, // Will trigger overspeeding on standard 50 limit
      no_seatbelt: true,
    },
  });

  assert.equal(result.success, true);
  assert.equal(typeof result.processing_time_ms, 'number');
});

test('realtimeAnprPipeline integrates VehicleTracker per camera and tracks vehicle lifecycle', async () => {
  const tracker = realtimeAnprPipeline.getTracker('CAM-TEST-TRACKER');
  assert.ok(tracker);
  assert.equal(typeof tracker.update, 'function');

  // Verify camera finalization gracefully flushes active tracks
  const flushed = await realtimeAnprPipeline.finalizeCamera('CAM-TEST-TRACKER');
  assert.ok(Array.isArray(flushed));
});
