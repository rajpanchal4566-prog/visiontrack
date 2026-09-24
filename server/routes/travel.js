const express = require('express');
const { getDb } = require('../database');
const { optionalAuth, getOrgCameraFilter } = require('../middleware/authMiddleware');

const router = express.Router();
router.use(optionalAuth);

function orgClause(req, alias = 'f') {
  const orgId = getOrgCameraFilter(req);
  return orgId ? { clause: ` JOIN cameras org_camera ON org_camera.id = ${alias}.second_camera_id WHERE org_camera.organization_id = ?`, params: [orgId] } : { clause: '', params: [] };
}

router.get('/flagged-vehicles', (req, res) => {
  const db = getDb();
  const filter = orgClause(req);
  const status = req.query.status;
  let query = `SELECT f.*, fc.name as first_camera_name, tc.name as second_camera_name
    FROM flagged_vehicle_events f
    JOIN cameras fc ON fc.id = f.first_camera_id
    JOIN cameras tc ON tc.id = f.second_camera_id${filter.clause}`;
  const params = [...filter.params];
  if (status) {
    query += filter.clause ? ' AND f.status = ?' : ' WHERE f.status = ?';
    params.push(status);
  }
  query += ' ORDER BY f.created_at DESC LIMIT ?';
  params.push(Math.min(200, Number(req.query.limit) || 50));
  res.json(db.prepare(query).all(...params));
});

router.get('/travel-validations', (req, res) => {
  const db = getDb();
  const filter = orgClause(req, 'v');
  let query = `SELECT v.*, COALESCE(v.speed_threshold_kmh, v.speed_limit_kmh * 1.25) as speed_threshold_kmh,
      fc.name as first_camera_name, tc.name as second_camera_name,
      fc.zone as first_camera_zone, tc.zone as second_camera_zone,
      fd.timestamp as first_detection_time, sd.timestamp as second_detection_time,
      cr.route_source, cr.route_status
    FROM travel_validations v
    JOIN cameras fc ON fc.id = v.first_camera_id
    JOIN cameras tc ON tc.id = v.second_camera_id
    JOIN detections fd ON fd.id = v.first_detection_id
    JOIN detections sd ON sd.id = v.second_detection_id
    LEFT JOIN camera_routes cr ON cr.from_camera_id = v.first_camera_id AND cr.to_camera_id = v.second_camera_id${filter.clause}`;
  const params = [...filter.params];
  if (req.query.status) {
    query += filter.clause ? ' AND v.status = ?' : ' WHERE v.status = ?';
    params.push(req.query.status);
  }
  query += ' ORDER BY v.created_at DESC LIMIT ?';
  params.push(Math.min(200, Number(req.query.limit) || 100));
  res.json(db.prepare(query).all(...params));
});

router.put('/flagged-vehicles/:id', (req, res) => {
  const db = getDb();
  const allowed = new Set(['NEW', 'UNDER_REVIEW', 'VERIFIED', 'DISMISSED']);
  if (!allowed.has(req.body?.status)) return res.status(400).json({ error: 'Invalid flagged vehicle status' });
  const result = db.prepare('UPDATE flagged_vehicle_events SET status = ? WHERE id = ?').run(req.body.status, req.params.id);
  if (!result.changes) return res.status(404).json({ error: 'Flagged vehicle not found' });
  res.json(db.prepare('SELECT * FROM flagged_vehicle_events WHERE id = ?').get(req.params.id));
});

router.get('/settings', (req, res) => {
  const db = getDb();
  const rows = db.prepare('SELECT key,value,updated_at FROM validation_settings ORDER BY key').all();
  res.json(Object.fromEntries(rows.map(row => [row.key, Number(row.value) || row.value])));
});

router.put('/settings', (req, res) => {
  const db = getDb();
  const allowed = new Set([
    'speeding_threshold_percentage', 'absolute_maximum_speed_kmh',
    'overspeed_threshold_kmh', 'default_speed_limit_kmh',
    'default_travel_speed_kmh', 'route_cache_ttl_hours',
    'route_max_distance_km',
  ]);
  const update = db.prepare(`INSERT INTO validation_settings (key,value,updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`);
  const updates = Object.entries(req.body || {}).filter(([key, value]) => allowed.has(key) && Number.isFinite(Number(value)));
  for (const [key, value] of updates) update.run(key, String(value));
  res.json(Object.fromEntries(db.prepare('SELECT key,value FROM validation_settings').all().map(row => [row.key, Number(row.value) || row.value])));
});

module.exports = router;