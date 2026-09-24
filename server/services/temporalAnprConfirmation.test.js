const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CONFIRMATION_STATES,
  formatConfidencePercent,
  createObservation,
  evaluateTrackObservations,
} = require('./temporalAnprConfirmation');
const { VehicleTracker, TrackedVehicle } = require('./vehicleTracker');

test('confidence-formatting: 0.8246 displays as 82.46%, never 8246%', () => {
  // Input 0.8246 (normalized unit float)
  assert.equal(formatConfidencePercent(0.8246), '82.46%');
  // Input 82.46 (already percentage)
  assert.equal(formatConfidencePercent(82.46), '82.46%');
  // Zero / null / undefined
  assert.equal(formatConfidencePercent(0), '0.00%');
  assert.equal(formatConfidencePercent(null), '0.00%');
  assert.equal(formatConfidencePercent(undefined), '0.00%');
  // Typical high-confidence detection (e.g. 0.985)
  assert.equal(formatConfidencePercent(0.985), '98.50%');
});

test('temporal confirmation: repeated same plate across frames reaches TRACK_CONFIRMED', () => {
  const observations = [
    createObservation({
      plate: 'DL01AB1234',
      confidence: 0.85,
      detectorConfidence: 0.88,
      bbox: { x: 100, y: 100, width: 80, height: 25 },
    }, { frameIndex: 1, timestamp: '2026-09-17T12:00:00Z' }),
    createObservation({
      plate: 'DL01AB1234',
      confidence: 0.89,
      detectorConfidence: 0.90,
      bbox: { x: 105, y: 102, width: 82, height: 26 },
    }, { frameIndex: 2, timestamp: '2026-09-17T12:00:01Z' }),
  ];

  const evalResult = evaluateTrackObservations(observations);
  assert.equal(evalResult.state, CONFIRMATION_STATES.TRACK_CONFIRMED);
  assert.equal(evalResult.confirmedPlate, 'DL01AB1234');
  assert.equal(evalResult.agreementCount, 2);
  assert.ok(evalResult.shouldSkipOcr, 'Sufficient agreement should signal skipping repeated OCR');
});

test('temporal confirmation: one bad read among good reads does not derail confirmed plate', () => {
  const observations = [
    createObservation({
      plate: 'TS05EC6531',
      confidence: 0.88,
      detectorConfidence: 0.85,
    }, { frameIndex: 1 }),
    // Misread/noisy frame with different text
    createObservation({
      plate: 'TS05XX9999',
      confidence: 0.52,
      detectorConfidence: 0.60,
    }, { frameIndex: 2 }),
    createObservation({
      plate: 'TS05EC6531',
      confidence: 0.92,
      detectorConfidence: 0.89,
    }, { frameIndex: 3 }),
    createObservation({
      plate: 'TS05EC6531',
      confidence: 0.90,
      detectorConfidence: 0.87,
    }, { frameIndex: 4 }),
  ];

  const evalResult = evaluateTrackObservations(observations);
  assert.equal(evalResult.state, CONFIRMATION_STATES.TRACK_CONFIRMED);
  assert.equal(evalResult.confirmedPlate, 'TS05EC6531');
  assert.equal(evalResult.agreementCount, 3);
  assert.ok(evalResult.shouldSkipOcr);
});

test('temporal confirmation: conflicting valid plates trigger NEEDS_CONFIRMATION', () => {
  const observations = [
    createObservation({
      plate: 'MH12DE1433',
      confidence: 0.75,
      detectorConfidence: 0.80,
    }, { frameIndex: 1 }),
    createObservation({
      plate: 'DL01AB1234',
      confidence: 0.76,
      detectorConfidence: 0.80,
    }, { frameIndex: 2 }),
  ];

  const evalResult = evaluateTrackObservations(observations);
  assert.equal(evalResult.state, CONFIRMATION_STATES.NEEDS_CONFIRMATION);
  assert.equal(evalResult.confirmedPlate, null, 'Conflicting reads should not produce a confirmed plate');
  assert.equal(evalResult.shouldSkipOcr, false, 'Conflicting reads must not skip OCR');
});

test('temporal confirmation: all invalid reads produce NO_VALID_PLATE', () => {
  const observations = [
    createObservation({
      plate: 'INVALID_GARBAGE!@#',
      confidence: 0.20,
    }, { frameIndex: 1 }),
    createObservation({
      plate: '12345', // Missing letters
      confidence: 0.30,
    }, { frameIndex: 2 }),
    createObservation({
      plate: 'XYZ', // Too short
      confidence: 0.25,
    }, { frameIndex: 3 }),
  ];

  const evalResult = evaluateTrackObservations(observations);
  assert.equal(evalResult.state, CONFIRMATION_STATES.NO_VALID_PLATE);
  assert.equal(evalResult.confirmedPlate, null);
  assert.equal(evalResult.validObservations, 0);
  assert.equal(evalResult.shouldSkipOcr, false);
});

test('temporal confirmation: low-confidence observations trigger NEEDS_CONFIRMATION', () => {
  const observations = [
    createObservation({
      plate: 'KA01AB1234',
      confidence: 0.28, // Below 40% confidence threshold
      detectorConfidence: 0.30,
      bbox: { x: 5, y: 5, width: 25, height: 10 },
    }, { frameIndex: 1 }),
  ];

  const evalResult = evaluateTrackObservations(observations);
  assert.equal(evalResult.state, CONFIRMATION_STATES.NEEDS_CONFIRMATION);
  assert.equal(evalResult.confirmedPlate, null);
});

test('temporal confirmation: track expiry and reset clears state cleanly', async () => {
  const tracker = new VehicleTracker({
    maxMissedFrames: 2,
    iouThreshold: 0.2,
  });

  // Frame 1: Vehicle appears with plate
  await tracker.update([{
    bbox: { x: 50, y: 50, width: 120, height: 80 },
    vehicleType: 'car',
    plate: 'HR26DK8337',
    confidence: 0.88,
  }], { frameIndex: 1 });

  assert.equal(tracker.activeTracks.size, 1);
  const track = Array.from(tracker.activeTracks.values())[0];
  assert.equal(track.id, 'TRK-001');
  assert.equal(track.observations.length, 1);

  // Frame 2 & 3: Missed frames -> track expires and finalizes
  await tracker.update([], { frameIndex: 2 });
  assert.equal(tracker.activeTracks.size, 1); // Missed 1 frame

  const res3 = await tracker.update([], { frameIndex: 3 }); // Missed 2 frames -> finalized
  assert.equal(tracker.activeTracks.size, 0, 'Expired track must be removed from active tracks');
  assert.equal(res3.finalized.length, 1);
  assert.equal(res3.finalized[0].trackId, 'TRK-001');
  assert.equal(res3.finalized[0].bestReading.plate, 'HR26DK8337');

  // Tracker reset clears all finalized and active history
  tracker.reset();
  assert.equal(tracker.activeTracks.size, 0);
  assert.equal(tracker.finalizedTracks.length, 0);
  assert.equal(tracker.nextTrackSeq, 1);
});

test('temporal confirmation: prefers longer, complete valid plate TS09UA2646 over repeated truncated prefix TS09UA26', () => {
  const observations = [
    // Frame 1: distant truncated read
    createObservation({
      plate: 'TS09UA26',
      confidence: 0.82,
      detectorConfidence: 0.85,
    }, { frameIndex: 1 }),
    // Frame 2: distant truncated read repeats
    createObservation({
      plate: 'TS09UA26',
      confidence: 0.85,
      detectorConfidence: 0.88,
    }, { frameIndex: 2 }),
    // Frame 3: distant truncated read repeats again
    createObservation({
      plate: 'TS09UA26',
      confidence: 0.86,
      detectorConfidence: 0.87,
    }, { frameIndex: 3 }),
    // Frame 4: vehicle comes closer, full 10-character plate is resolved with solid confidence
    createObservation({
      plate: 'TS09UA2646',
      confidence: 0.92,
      detectorConfidence: 0.90,
    }, { frameIndex: 4 }),
  ];

  const evalResult = evaluateTrackObservations(observations);
  assert.equal(evalResult.state, CONFIRMATION_STATES.TRACK_CONFIRMED);
  assert.equal(evalResult.confirmedPlate, 'TS09UA2646', 'Complete 10-character plate must win over truncated 8-character prefix even if prefix was observed more times');
  assert.equal(evalResult.authoritativeReading.normalizedPlate, 'TS09UA2646');
});

