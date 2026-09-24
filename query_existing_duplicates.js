const path = require('path');
const { getDb } = require('./server/database.js');
const db = getDb();

console.log('=== SCHEMA OF DETECTIONS TABLE ===');
const columns = db.prepare('PRAGMA table_info(detections)').all();
console.log(columns.map(c => c.name).join(', '));

console.log('\n=== QUERYING EXISTING ROWS FOR TS09EG6531, AP10A0, AB00AR6 (and variants) ===');
const rows = db.prepare(`
  SELECT id, event_id, plate, camera_id, timestamp, confidence, speed, source_type, investigation_details
  FROM detections
  WHERE plate LIKE '%TS09EG6531%'
     OR plate LIKE '%TS09EGG531%'
     OR plate LIKE '%AP10A%'
     OR plate LIKE '%AB00%'
     OR plate LIKE '%AR6%'
  ORDER BY timestamp DESC
  LIMIT 50
`).all();

console.log(`Found ${rows.length} rows:`);
for (const r of rows) {
  let trackInfo = 'None';
  try {
    if (r.investigation_details) {
      const parsed = JSON.parse(r.investigation_details);
      trackInfo = `trackId=${parsed.trackId || parsed.track_id}, framesTracked=${parsed.framesTracked || parsed.frames_tracked}, vehicleBbox=${JSON.stringify(parsed.vehicleBbox)}`;
    }
  } catch (_) {
    trackInfo = r.investigation_details;
  }
  console.log(`\nID: ${r.id} | Plate: ${r.plate} | Camera: ${r.camera_id} | Time: ${r.timestamp}`);
  console.log(`  event_id: ${r.event_id}`);
  console.log(`  Tracker Ref: ${trackInfo}`);
  console.log(`  Source: ${r.source_type} | Conf: ${r.confidence} | Speed: ${r.speed}`);
}
