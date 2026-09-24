const express = require('express');
const router = express.Router();
const { getDb } = require('../database');
const { optionalAuth, getOrgCameraFilter } = require('../middleware/authMiddleware');

// Apply optional auth to all alert routes
router.use(optionalAuth);

// GET /api/alerts — List alerts (org-scoped)
router.get('/', (req, res) => {
  const db = getDb();
  const { severity, status, limit = 50 } = req.query;
  const orgId = getOrgCameraFilter(req);

  let query = `
    SELECT a.*, d.image_path, d.vehicle_type, d.vehicle_color, d.confidence,
      c.name as camera_name, c.lat as camera_lat, c.lng as camera_lng,
      o.name as organization_name, c.organization_id
    FROM alerts a
    LEFT JOIN detections d ON a.detection_id = d.id
    JOIN cameras c ON a.camera_id = c.id
    LEFT JOIN organizations o ON c.organization_id = o.id
    WHERE 1=1
  `;
  const params = [];

  if (orgId) {
    query += ' AND c.organization_id IN (SELECT id FROM organizations WHERE id = ? OR parent_organization_id = ?)';
    params.push(orgId, orgId);
  }
  if (severity) { query += ' AND a.severity = ?'; params.push(severity); }
  if (status) { query += ' AND a.status = ?'; params.push(status); }

  query += ' ORDER BY a.timestamp DESC LIMIT ?';
  params.push(parseInt(limit));

  const alerts = db.prepare(query).all(...params);
  res.json(alerts);
});

// GET /api/alerts/stats — Alert counts (org-scoped)
router.get('/stats', (req, res) => {
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);
  const orgId = getOrgCameraFilter(req);

  if (orgId) {
    const total = db.prepare(
      "SELECT COUNT(*) as count FROM alerts a JOIN cameras c ON a.camera_id = c.id WHERE date(a.timestamp) = ? AND c.organization_id IN (SELECT id FROM organizations WHERE id = ? OR parent_organization_id = ?)"
    ).get(today, orgId, orgId).count;
    const active = db.prepare(
      "SELECT COUNT(*) as count FROM alerts a JOIN cameras c ON a.camera_id = c.id WHERE a.status = 'active' AND c.organization_id IN (SELECT id FROM organizations WHERE id = ? OR parent_organization_id = ?)"
    ).get(orgId, orgId).count;
    const critical = db.prepare(
      "SELECT COUNT(*) as count FROM alerts a JOIN cameras c ON a.camera_id = c.id WHERE a.severity = 'critical' AND a.status = 'active' AND c.organization_id IN (SELECT id FROM organizations WHERE id = ? OR parent_organization_id = ?)"
    ).get(orgId, orgId).count;
    const bySeverity = db.prepare(`
      SELECT a.severity, COUNT(*) as count FROM alerts a 
      JOIN cameras c ON a.camera_id = c.id
      WHERE date(a.timestamp) = ? AND c.organization_id IN (SELECT id FROM organizations WHERE id = ? OR parent_organization_id = ?) GROUP BY a.severity
    `).all(today, orgId, orgId);
    res.json({ total, active, critical, bySeverity, today: total });
  } else {
    const total = db.prepare("SELECT COUNT(*) as count FROM alerts WHERE date(timestamp) = ?").get(today).count;
    const active = db.prepare("SELECT COUNT(*) as count FROM alerts WHERE status = 'active'").get().count;
    const critical = db.prepare("SELECT COUNT(*) as count FROM alerts WHERE severity = 'critical' AND status = 'active'").get().count;
    const bySeverity = db.prepare(`
      SELECT severity, COUNT(*) as count FROM alerts 
      WHERE date(timestamp) = ? GROUP BY severity
    `).all(today);
    res.json({ total, active, critical, bySeverity, today: total });
  }
});

// PUT /api/alerts/:id/resolve — Resolve an alert
router.put('/:id/resolve', (req, res) => {
  const db = getDb();
  db.prepare("UPDATE alerts SET status = 'resolved' WHERE id = ?").run(req.params.id);
  const alert = db.prepare('SELECT * FROM alerts WHERE id = ?').get(req.params.id);
  res.json(alert);
});

module.exports = router;
