const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  VehicleTracker,
  TrackedVehicle,
  bboxIoU,
  centroidDistanceRatio,
  selectBestOcrReading,
} = require('./vehicleTracker');

test('bboxIoU calculates overlap accurately', () => {
  const b1 = { x: 10, y: 10, width: 100, height: 100 };
  const b2 = { x: 10, y: 10, width: 100, height: 100 };
  assert.equal(bboxIoU(b1, b2), 1.0);

  const b3 = { x: 60, y: 10, width: 100, height: 100 };
  // intersection: 50 * 100 = 5000. union: 10000 + 10000 - 5000 = 15000. iou = 5000 / 15000 = 0.333...
  const iou = bboxIoU(b1, b3);
  assert.ok(Math.abs(iou - (1 / 3)) < 0.01);

  const bDisjoint = { x: 200, y: 200, width: 50, height: 50 };
  assert.equal(bboxIoU(b1, bDisjoint), 0.0);
});

test('centroidDistanceRatio measures normalized displacement', () => {
  const b1 = { x: 0, y: 0, width: 100, height: 100 };
  const b2 = { x: 0, y: 0, width: 100, height: 100 };
  assert.equal(centroidDistanceRatio(b1, b2), 0.0);

  const bMoved = { x: 30, y: 40, width: 100, height: 100 };
  // centroid dist = sqrt(30^2 + 40^2) = 50. average diagonal = sqrt(100^2 + 100^2) ~= 141.42
  const ratio = centroidDistanceRatio(b1, bMoved);
  assert.ok(ratio > 0.3 && ratio < 0.4);
});

test('selectBestOcrReading selects highest quality and consistent reading', () => {
  const readings = [
    { plate: 'TS03EC6531', ocrText: 'TS03EC6531', confidence: 0.65 },
    { plate: 'TS05E6E531', ocrText: 'TS05E6E531', confidence: 0.72 },
    { plate: 'TS05EC6531', ocrText: 'TS05EC6531', confidence: 0.91 },
    { plate: 'TS05EC6531', ocrText: 'TS05EC6531', confidence: 0.88 },
  ];

  const best = selectBestOcrReading(readings);
  assert.equal(best.plate, 'TS05EC6531');
  assert.equal(best.confidence, 0.91);
});

test('VehicleTracker maintains track across consecutive sampled frames and finalizes exactly once', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vtracker-test-'));
  const dummyBuffer1 = Buffer.from('FRAME1');
  const dummyBuffer2 = Buffer.from('FRAME2');
  const dummyBuffer3 = Buffer.from('FRAME3');

  const finalizedRecords = [];
  const tracker = new VehicleTracker({
    maxMissedFrames: 2,
    iouThreshold: 0.2,
    uploadsDir: tempDir,
    onTrackFinalized: async (rec) => {
      finalizedRecords.push(rec);
    },
  });

  // Frame 1: Vehicle appears
  const f1Dets = [{
    bbox: { x: 100, y: 120, width: 180, height: 110 },
    vehicleType: 'car',
    plate: 'TS03EC6531',
    ocrText: 'TS03EC6531',
    confidence: 0.65,
  }];
  const res1 = await tracker.update(f1Dets, { frameIndex: 1, timestamp: '2026-09-17T10:00:00Z', frameBuffer: dummyBuffer1 });
  assert.equal(res1.activeTracks.length, 1);
  assert.equal(res1.activeTracks[0].id, 'TRK-001');
  assert.equal(res1.activeTracks[0].framesTracked, 1);
  assert.equal(res1.finalized.length, 0);
  assert.equal(finalizedRecords.length, 0);

  // Frame 2: Vehicle moves slightly
  const f2Dets = [{
    bbox: { x: 125, y: 125, width: 182, height: 112 },
    vehicleType: 'car',
    plate: 'TS05E6E531',
    ocrText: 'TS05E6E531',
    confidence: 0.72,
  }];
  const res2 = await tracker.update(f2Dets, { frameIndex: 2, timestamp: '2026-09-17T10:00:01Z', frameBuffer: dummyBuffer2 });
  assert.equal(res2.activeTracks.length, 1);
  assert.equal(res2.activeTracks[0].id, 'TRK-001');
  assert.equal(res2.activeTracks[0].framesTracked, 2);
  assert.equal(res2.activeTracks[0].ocrReadings.length, 2);
  assert.equal(finalizedRecords.length, 0);

  // Frame 3: Vehicle moves further, gives clean reading
  const f3Dets = [{
    bbox: { x: 155, y: 130, width: 185, height: 115 },
    vehicleType: 'car',
    plate: 'TS05EC6531',
    ocrText: 'TS05EC6531',
    confidence: 0.92,
  }];
  const res3 = await tracker.update(f3Dets, { frameIndex: 3, timestamp: '2026-09-17T10:00:02Z', frameBuffer: dummyBuffer3 });
  assert.equal(res3.activeTracks.length, 1);
  assert.equal(res3.activeTracks[0].id, 'TRK-001');
  assert.equal(res3.activeTracks[0].framesTracked, 3);
  assert.equal(res3.activeTracks[0].ocrReadings.length, 3);
  assert.equal(finalizedRecords.length, 0);

  // Frame 4: Vehicle has left (missed frame 1)
  const res4 = await tracker.update([], { frameIndex: 4, timestamp: '2026-09-17T10:00:03Z' });
  assert.equal(res4.activeTracks.length, 1);
  assert.equal(res4.activeTracks[0].missedFrames, 1);
  assert.equal(finalizedRecords.length, 0);

  // Frame 5: Vehicle still gone (missed frame 2 -> triggers finalization!)
  const res5 = await tracker.update([], { frameIndex: 5, timestamp: '2026-09-17T10:00:04Z' });
  assert.equal(res5.activeTracks.length, 0);
  assert.equal(res5.finalized.length, 1);
  assert.equal(finalizedRecords.length, 1);

  // Verify the finalized record details
  const final = finalizedRecords[0];
  assert.equal(final.trackId, 'TRK-001');
  assert.equal(final.framesTracked, 3);
  assert.equal(final.totalReadings, 3);
  assert.equal(final.hasPlate, true);
  assert.equal(final.bestReading.plate, 'TS05EC6531');
  assert.equal(final.bestReading.confidence, 0.92);
  assert.ok(final.bestReading.imagePath.includes('/uploads/detections/snap_DET-'));

  // Verify snapshot file was created on disk
  const savedFiles = fs.readdirSync(tempDir);
  assert.equal(savedFiles.length, 1);
  const savedContent = fs.readFileSync(path.join(tempDir, savedFiles[0]));
  assert.equal(savedContent.toString(), 'FRAME3'); // matches best reading buffer!

  // Cleanup
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('finalizeAll flushes in-flight active tracks when video finishes', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vtracker-flush-'));
  const tracker = new VehicleTracker({
    maxMissedFrames: 5,
    uploadsDir: tempDir,
  });

  await tracker.update([{
    bbox: { x: 50, y: 50, width: 100, height: 80 },
    vehicleType: 'truck',
    plate: 'MH12AB1234',
    confidence: 0.85,
  }], { frameIndex: 1, frameBuffer: Buffer.from('TRUCK_FRAME') });

  assert.equal(tracker.activeTracks.size, 1);
  assert.equal(tracker.finalizedTracks.length, 0);

  // Video stream ends
  const flushed = await tracker.finalizeAll();
  assert.equal(flushed.length, 1);
  assert.equal(tracker.activeTracks.size, 0);
  assert.equal(flushed[0].trackId, 'TRK-001');
  assert.equal(flushed[0].bestReading.plate, 'MH12AB1234');
  assert.equal(flushed[0].vehicleType, 'truck');

  fs.rmSync(tempDir, { recursive: true, force: true });
});
