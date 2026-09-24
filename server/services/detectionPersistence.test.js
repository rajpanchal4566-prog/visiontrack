const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { getDb } = require('../database');
const {
  insertDetection,
  levenshteinDistance,
  isFuzzyPlateMatch,
} = require('./detectionPersistence');

test('levenshteinDistance computes correct edit distances', () => {
  assert.equal(levenshteinDistance('TS09EG6531', 'TS09EG6531'), 0);
  assert.equal(levenshteinDistance('TS09EG6531', 'TS09EGG531'), 1);
  assert.equal(levenshteinDistance('AP10AR0658', 'AP10AR0858'), 1);
  assert.equal(levenshteinDistance('AP10AR0658', 'AP10AR2659'), 2);
  assert.equal(levenshteinDistance('AP10A0', 'AP10A0'), 0);
  assert.equal(levenshteinDistance('AB00AR6', 'AB00AR6'), 0);
});

test('isFuzzyPlateMatch recognizes exact, edit-distance, and truncation matches', () => {
  assert.equal(isFuzzyPlateMatch('TS09EG6531', 'TS09EG6531'), true);
  assert.equal(isFuzzyPlateMatch('TS09EG6531', 'TS09EGG531'), true);
  assert.equal(isFuzzyPlateMatch('AP10AR0658', 'AP10AR0858'), true);
  assert.equal(isFuzzyPlateMatch('AP10AR0658', 'AP10AR6'), true); // prefix truncation
  assert.equal(isFuzzyPlateMatch('AP10A0', 'AP10A0'), true);
  assert.equal(isFuzzyPlateMatch('AB00AR6', 'AB00AR6'), true);
  assert.equal(isFuzzyPlateMatch('TS09EG6531', 'DL01AB1234'), false);
});

test('time-window backstop deduplication prevents duplicate insertion within 30 seconds', () => {
  const db = getDb();
  const testCamId = `CAM-TEST-DEDUP-${Date.now()}`;

  // Insert dummy camera if not present
  try {
    db.prepare('INSERT OR IGNORE INTO cameras (id, name, city, lat, lng, zone) VALUES (?, ?, ?, ?, ?, ?)')
      .run(testCamId, 'Dedup Test Camera', 'Pune', 18.52, 73.85, 'Zone-1');
  } catch (_) {}

  const baseTime = new Date('2026-09-18T10:00:00.000Z');

  // First reading: TS09EG6531 with 0.82 confidence
  const firstRes = insertDetection({
    id: `DET-T1-${Date.now()}`,
    event_id: `evt-t1-${Date.now()}`,
    plate: 'TS09EG6531',
    camera_id: testCamId,
    timestamp: baseTime.toISOString(),
    confidence: 0.82,
    vehicle_type: 'car',
    speed: 15,
  }, { dedupWindowSeconds: 30 });

  assert.equal(firstRes.duplicate, false);
  assert.equal(firstRes.updated, false);

  // Second reading 2 seconds later: identical TS09EG6531 with lower confidence (0.80)
  const secondRes = insertDetection({
    id: `DET-T2-${Date.now()}`,
    event_id: `evt-t2-${Date.now()}`,
    plate: 'TS09EG6531',
    camera_id: testCamId,
    timestamp: new Date(baseTime.getTime() + 2000).toISOString(),
    confidence: 0.80,
    vehicle_type: 'car',
    speed: 16,
  }, { dedupWindowSeconds: 30 });

  assert.equal(secondRes.duplicate, true);
  assert.equal(secondRes.updated, false);
  assert.equal(secondRes.id, firstRes.id);

  // Third reading 4 seconds later: fuzzy variant TS09EGG531 with higher confidence (0.95)
  const thirdRes = insertDetection({
    id: `DET-T3-${Date.now()}`,
    event_id: `evt-t3-${Date.now()}`,
    plate: 'TS09EGG531',
    camera_id: testCamId,
    timestamp: new Date(baseTime.getTime() + 4000).toISOString(),
    confidence: 0.95,
    vehicle_type: 'car',
    speed: 18,
  }, { dedupWindowSeconds: 30 });

  assert.equal(thirdRes.duplicate, true);
  assert.equal(thirdRes.updated, true);
  assert.equal(thirdRes.id, firstRes.id);

  // Verify the row in the database was updated in place
  const updatedRow = db.prepare('SELECT id, plate, confidence, speed FROM detections WHERE id = ?').get(firstRes.id);
  assert.equal(updatedRow.confidence, 0.95);
  assert.equal(updatedRow.speed, 18);

  // Fourth reading: 35 seconds later (after window expires) should be accepted as a new sighting
  const fourthRes = insertDetection({
    id: `DET-T4-${Date.now()}`,
    event_id: `evt-t4-${Date.now()}`,
    plate: 'TS09EG6531',
    camera_id: testCamId,
    timestamp: new Date(baseTime.getTime() + 35000).toISOString(),
    confidence: 0.88,
    vehicle_type: 'car',
    speed: 20,
  }, { dedupWindowSeconds: 30 });

  assert.equal(fourthRes.duplicate, false);
  assert.notEqual(fourthRes.id, firstRes.id);
});
