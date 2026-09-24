const { initializeDatabase, getDb } = require('../database');
const { validateDetection } = require('../services/travelValidation');

initializeDatabase();
const db = getDb();
const organizationId = 'ORG-TRAVEL-DEMO';
db.prepare(`INSERT OR IGNORE INTO organizations (id, name, city, state, organization_type, api_key)
  VALUES (?, 'Travel Validation Demo', 'Pune', 'Maharashtra', 'demo', ?)`)
  .run(organizationId, 'demo_travel_validation_key');

const cameras = [
  ['CAM-001', 'Demo Gate A', 18.5204, 73.8567, 'Central Gate'],
  ['CAM-002', 'Demo Junction B', 18.5314, 73.8446, 'North Junction'],
  ['CAM-003', 'Demo Highway C', 18.6908, 73.8753, 'Highway Exit'],
];
const insertCamera = db.prepare(`INSERT OR IGNORE INTO cameras
  (id, name, city, lat, lng, zone, status, type, uptime, organization_id, api_token, endpoint_status)
  VALUES (?, ?, 'Pune', ?, ?, ?, 'online', 'metadata', 99, ?, ?, 'connected')`);
for (const [id, name, lat, lng, zone] of cameras) {
  insertCamera.run(id, name, lat, lng, zone, organizationId, `demo_token_${id}`);
}

const insertDetection = db.prepare(`INSERT OR IGNORE INTO detections
  (id, event_id, plate, camera_id, location_id, timestamp, confidence, vehicle_type)
  VALUES (?, ?, ?, ?, ?, ?, ?, 'Sedan')`);

async function seedScenario(plate, firstCamera, secondCamera, firstTime, secondTime, confidence = 0.98) {
  const scenarioKey = plate.replace(/^DEMO-/, '');
  const firstId = `DEMO-${scenarioKey}-A`;
  const secondId = `DEMO-${scenarioKey}-B`;
  insertDetection.run(firstId, `${firstId}-event`, plate, firstCamera, 'demo', firstTime, confidence);
  insertDetection.run(secondId, `${secondId}-event`, plate, secondCamera, 'demo', secondTime, confidence);
  await validateDetection({ id: firstId });
  return validateDetection({ id: secondId });
}

(async () => {
  await seedScenario('DEMO-NORMAL', 'CAM-001', 'CAM-002', '2026-09-14T10:00:00Z', '2026-09-14T10:12:00Z');
  await seedScenario('DEMO-SPEED', 'CAM-001', 'CAM-002', '2026-09-14T11:00:00Z', '2026-09-14T11:02:00Z');
  await seedScenario('DEMO-IMPOSSIBLE', 'CAM-001', 'CAM-003', '2026-09-14T12:00:00Z', '2026-09-14T12:04:00Z', 0.55);
  console.log('Travel validation demo data seeded: DEMO-NORMAL, DEMO-SPEED, DEMO-IMPOSSIBLE');
})().catch(error => { console.error(error); process.exitCode = 1; });