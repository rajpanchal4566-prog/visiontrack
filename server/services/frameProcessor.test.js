const assert = require('assert');
const test = require('node:test');
const { EvidenceDeduplicator, normalizePlate, evidenceScore } = require('./frameProcessor');
const { extractJpegs } = require('./frameStream');

test('normalizes plates consistently for deduplication', () => {
  assert.equal(normalizePlate('mh-12 ab 1234'), 'MH12AB1234');
});

test('deduplicator keeps the best evidence in its window', () => {
  const dedup = new EvidenceDeduplicator({ windowMs: 1000 });
  const first = { camera_id: 'cam-1', plate: 'MH12AB1234', confidence: 0.5, plate_confidence: 0.5 };
  const better = { camera_id: 'cam-1', plate: 'MH12AB1234', confidence: 0.9, plate_confidence: 0.9 };
  assert.equal(dedup.consider(first, 100).accepted, true);
  assert.equal(dedup.consider({ ...first }, 200).accepted, false);
  const result = dedup.consider(better, 300);
  assert.equal(result.accepted, true);
  assert.equal(result.replacement, true);
  assert(evidenceScore(result.result) > evidenceScore(first));
});

test('deduplicator accepts a plate after the window expires', () => {
  const dedup = new EvidenceDeduplicator({ windowMs: 100 });
  const frame = { camera_id: 'cam-1', plate: 'MH12AB1234', confidence: 0.5 };
  assert.equal(dedup.consider(frame, 0).accepted, true);
  assert.equal(dedup.consider(frame, 101).accepted, true);
});

test('extracts complete JPEG frames across arbitrary chunk boundaries', () => {
  const frames = [];
  const first = Buffer.from([0xff, 0xd8, 1, 2, 0xff, 0xd9]);
  const second = Buffer.from([0xff, 0xd8, 3, 4, 0xff, 0xd9]);
  let pending = extractJpegs(Buffer.concat([first.slice(0, 3)]), frame => frames.push(frame));
  pending = extractJpegs(Buffer.concat([pending, first.slice(3), second]), frame => frames.push(frame));
  assert.equal(frames.length, 2);
  assert.deepEqual(frames[0], first);
  assert.deepEqual(frames[1], second);
});
