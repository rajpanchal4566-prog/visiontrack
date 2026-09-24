const express = require('express');
const router = express.Router();
const { getDb } = require('../database');
const { optionalAuth, getOrgCameraFilter } = require('../middleware/authMiddleware');

// Apply optional auth to all vehicle routes
router.use(optionalAuth);

function normalizePlate(value) {
  return String(value || '').replace(/[^a-z0-9]/gi, '').toUpperCase();
}

// GET /api/vehicles/search?plate=MH-12 — Search vehicles (org-scoped)
router.get('/search', (req, res) => {
  const db = getDb();
  const { plate } = req.query;
  const normalizedPlate = normalizePlate(plate);
  if (!normalizedPlate) return res.status(400).json({ error: 'Plate query required' });

  const orgId = getOrgCameraFilter(req);

  let query = `
    SELECT d.plate, d.vehicle_type, d.vehicle_color,
      MIN(d.timestamp) as first_seen,
      MAX(d.timestamp) as last_seen,
      COUNT(*) as total_sightings,
      AVG(d.confidence) as avg_confidence
    FROM detections d
  `;
  const params = [];

  if (orgId) {
    query += " JOIN cameras c ON d.camera_id = c.id WHERE REPLACE(REPLACE(UPPER(d.plate), '-', ''), ' ', '') LIKE ? AND c.organization_id = ?";
    params.push(`%${normalizedPlate}%`, orgId);
  } else {
    query += " WHERE REPLACE(REPLACE(UPPER(d.plate), '-', ''), ' ', '') LIKE ?";
    params.push(`%${normalizedPlate}%`);
  }

  query += ' GROUP BY d.plate ORDER BY total_sightings DESC LIMIT 20';

  const vehicles = db.prepare(query).all(...params);

  // Check watchlist status for each
  const watchlistCheck = db.prepare('SELECT * FROM watchlist WHERE plate = ? AND is_active = 1');
  const results = vehicles.map(v => ({
    ...v,
    avg_confidence: +(v.avg_confidence || 0).toFixed(3),
    watchlist: watchlistCheck.get(v.plate) || null,
  }));

  res.json(results);
});

// GET /api/vehicles/:plate/trajectory — Full trajectory with camera geo coords (org-scoped)
router.get('/:plate/trajectory', (req, res) => {
  const db = getDb();
  const plate = req.params.plate;
  const normalizedPlate = normalizePlate(plate);
  const orgId = getOrgCameraFilter(req);

  // Join detections with camera locations
  let query = `
    SELECT d.id, d.plate, d.camera_id, d.timestamp, d.confidence, 
           d.vehicle_type, d.vehicle_color, d.speed, d.image_path,
              c.name as camera_name, c.city as camera_city,
              c.lat as camera_lat, c.lng as camera_lng, c.zone as camera_zone,
              c.organization_id, o.name as organization_name
    FROM detections d
            JOIN cameras c ON d.camera_id = c.id
            LEFT JOIN organizations o ON o.id = c.organization_id
    WHERE REPLACE(REPLACE(UPPER(d.plate), '-', ''), ' ', '') = ?
  `;
  const params = [normalizedPlate];
  if (orgId) { query += ' AND c.organization_id = ?'; params.push(orgId); }
  query += ' ORDER BY d.timestamp ASC';

  const sightings = db.prepare(query).all(...params);

  if (sightings.length === 0) {
    return res.status(404).json({ error: 'No sightings found for this plate' });
  }

  const watchlist = db.prepare(
    "SELECT * FROM watchlist WHERE REPLACE(REPLACE(UPPER(plate), '-', ''), ' ', '') = ? AND is_active = 1"
  ).get(normalizedPlate);

  // Build trajectory path (deduplicate consecutive same-camera entries)
  const trajectory = [];
  let lastCameraId = null;
  for (const s of sightings) {
    if (s.camera_id !== lastCameraId) {
      trajectory.push({
        id: s.id,
        camera_id: s.camera_id,
        camera_name: s.camera_name,
        camera_city: s.camera_city,
        lat: s.camera_lat,
        lng: s.camera_lng,
        zone: s.camera_zone,
        timestamp: s.timestamp,
        confidence: s.confidence,
        speed: s.speed,
        image_path: s.image_path,
      });
      lastCameraId = s.camera_id;
    }
  }

  res.json({
    plate: sightings[0].plate,
    vehicle_type: sightings[0].vehicle_type,
    vehicle_color: sightings[0].vehicle_color,
    first_seen: sightings[0].timestamp,
    last_seen: sightings[sightings.length - 1].timestamp,
    total_sightings: sightings.length,
    watchlist: watchlist || null,
    trajectory,
    all_sightings: sightings,
    validations: db.prepare(`
      SELECT v.*, fc.name as first_camera_name, tc.name as second_camera_name
      FROM travel_validations v
      JOIN cameras fc ON fc.id = v.first_camera_id
      JOIN cameras tc ON tc.id = v.second_camera_id
      WHERE v.plate = ? ORDER BY v.created_at ASC
    `).all(plate),
  });
});

// GET /api/vehicles/:plate/history — Detections and validation transitions
router.get('/:plate/history', (req, res) => {
  const db = getDb();
  const plate = req.params.plate;
  const detections = db.prepare(`
    SELECT d.*, c.name as camera_name, c.city, c.zone, c.lat, c.lng
    FROM detections d JOIN cameras c ON c.id = d.camera_id
    WHERE d.plate = ? ORDER BY d.timestamp ASC
  `).all(plate);
  const validations = db.prepare('SELECT * FROM travel_validations WHERE plate = ? ORDER BY created_at ASC').all(plate);
  if (!detections.length) return res.status(404).json({ error: 'No sightings found for this plate' });
  res.json({ plate, detections, validations });
});

module.exports = router;
