const path = require('path');
const { getDb } = require('./server/database.js');
const db = getDb();

console.log('=== EXACT OR CLOSE MATCHES FOR AP10A0 and AB00AR6 ===');
const ap10Rows = db.prepare(`
  SELECT id, event_id, plate, camera_id, timestamp, confidence, source_type, investigation_details
  FROM detections
  WHERE plate = 'AP10A0' OR plate = 'AB00AR6' OR plate LIKE 'AP10A0%' OR plate LIKE 'AB00AR6%'
`).all();
console.log('Direct exact matches:', ap10Rows);

console.log('\n=== ALL TS09EG6531 ROWS ON CAM-CDC087EE (around 4:54 AM / 23:24 UTC) ===');
const tsRows = db.prepare(`
  SELECT id, event_id, plate, camera_id, timestamp, confidence, speed, source_type, investigation_details
  FROM detections
  WHERE camera_id = 'CAM-CDC087EE'
    AND timestamp >= '2026-09-17T23:24:00Z'
    AND timestamp <= '2026-09-17T23:25:00Z'
    AND (plate LIKE '%TS09EG6531%' OR plate LIKE '%TS09EGG531%')
  ORDER BY timestamp ASC
`).all();

for (const r of tsRows) {
  console.log(`\nID: ${r.id} | Event: ${r.event_id} | Plate: ${r.plate} | Time: ${r.timestamp}`);
  console.log(`  Details: ${r.investigation_details}`);
}
