const express = require('express');
const { getDb } = require('../database');
const { normalizeDetection, expandPayloads } = require('../services/vendorAdapter');

const router = express.Router();

// ──────────────────────────────────────────────
// Check vehicle against flagged_vehicles + watchlist
// ──────────────────────────────────────────────
function checkFlags(db, plate) {
  if (!plate) return { flagged: false, flags: [], watchlist: null };

  const flags = db.prepare(
    'SELECT * FROM flagged_vehicles WHERE plate = ? AND is_active = 1'
  ).all(plate);

  // Also check existing watchlist (interop with existing system)
  const watchlistEntry = db.prepare(
    'SELECT * FROM watchlist WHERE plate = ? AND is_active = 1'
  ).get(plate);

  const allFlags = [];

  for (const f of flags) {
    // Check expiry
    if (f.expires_on && new Date(f.expires_on) < new Date()) continue;
    allFlags.push({
      id: f.id,
      type: f.flag_type,
      severity: f.severity,
      description: f.description,
      issuing_authority: f.issuing_authority,
      case_number: f.case_number,
      flagged_on: f.flagged_on,
      expires_on: f.expires_on,
    });
  }

  // Add watchlist as a flag too
  if (watchlistEntry) {
    allFlags.push({
      id: `wl-${watchlistEntry.id}`,
      type: watchlistEntry.list_type === 'blacklist' ? 'wanted' : 'whitelisted',
      severity: watchlistEntry.list_type === 'blacklist' ? 'critical' : 'info',
      description: watchlistEntry.reason,
      issuing_authority: watchlistEntry.added_by,
      case_number: null,
      flagged_on: watchlistEntry.added_on,
      expires_on: null,
      source: 'watchlist',
    });
  }

  // Determine highest severity
  const severityOrder = { critical: 0, high: 1, warning: 2, info: 3 };
  allFlags.sort((a, b) => (severityOrder[a.severity] || 99) - (severityOrder[b.severity] || 99));

  return {
    flagged: allFlags.length > 0,
    flag_count: allFlags.length,
    highest_severity: allFlags.length > 0 ? allFlags[0].severity : null,
    flags: allFlags,
    watchlist: watchlistEntry || null,
  };
}

// ──────────────────────────────────────────────
// POST /api/decode — Decode raw JSON payload
// ──────────────────────────────────────────────
router.post('/', (req, res) => {
  const db = getDb();
  const rawBody = req.body;

  if (!rawBody || typeof rawBody !== 'object') {
    return res.status(400).json({ error: 'Request body must be a valid JSON object or array' });
  }

  // Support both single object and array of detections
  const payloads = expandPayloads(rawBody);
  const results = [];

  for (const raw of payloads) {
    const { detection: decoded, resolutionSummary, vendor } = normalizeDetection(raw);

    if (!decoded.plate) {
      results.push({
        decoded,
        error: 'Could not extract plate number from JSON',
        flag_result: { flagged: false, flags: [] },
        raw_fields_found: Object.keys(raw),
        vendor,
        resolution_path: resolutionSummary,
      });
      // Still log it
      db.prepare(
        'INSERT INTO ingest_log (raw_json, decoded_plate, camera_id, flag_hit, flag_details, resolution_path) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(JSON.stringify(raw), null, decoded.camera_id, 0, null, resolutionSummary);
      continue;
    }

    // Check flags
    const flagResult = checkFlags(db, decoded.plate);

    // Log the decode operation
    db.prepare(
      'INSERT INTO ingest_log (raw_json, decoded_plate, camera_id, flag_hit, flag_details, resolution_path) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(
      JSON.stringify(raw),
      decoded.plate,
      decoded.camera_id,
      flagResult.flagged ? 1 : 0,
      flagResult.flagged ? JSON.stringify(flagResult.flags) : null,
      resolutionSummary,
    );

    // Emit socket event for flag hits
    if (flagResult.flagged && global.io) {
      global.io.emit('flag:hit', {
        plate: decoded.plate,
        flags: flagResult.flags,
        highest_severity: flagResult.highest_severity,
        decoded,
        timestamp: new Date().toISOString(),
      });
    }

    // Resolve camera info from DB if camera_id was provided
    let cameraInfo = null;
    if (decoded.camera_id) {
      cameraInfo = db.prepare('SELECT id, name, city, zone, lat, lng FROM cameras WHERE id = ?').get(decoded.camera_id);
    }

    results.push({
      decoded: {
        ...decoded,
        camera_info: cameraInfo || { id: decoded.camera_id, name: decoded.camera_name },
      },
      flag_result: flagResult,
      status: flagResult.flagged ? 'FLAGGED' : 'CLEAR',
      raw_fields_found: Object.keys(raw),
      vendor,
      resolution_path: resolutionSummary,
    });
  }

  res.json({
    total: results.length,
    flagged_count: results.filter(r => r.flag_result?.flagged).length,
    results,
  });
});

// ──────────────────────────────────────────────
// GET /api/decode/log — Decode audit trail
// ──────────────────────────────────────────────
router.get('/log', (req, res) => {
  const db = getDb();
  const limit = parseInt(req.query.limit) || 50;
  const offset = parseInt(req.query.offset) || 0;

  const logs = db.prepare(
    'SELECT * FROM ingest_log ORDER BY received_at DESC LIMIT ? OFFSET ?'
  ).all(limit, offset);

  const total = db.prepare('SELECT COUNT(*) as count FROM ingest_log').get().count;

  res.json({ logs, total });
});

// ──────────────────────────────────────────────
// GET /api/decode/flags — List flagged vehicles
// ──────────────────────────────────────────────
router.get('/flags', (req, res) => {
  const db = getDb();
  const { type, active } = req.query;

  let query = 'SELECT * FROM flagged_vehicles WHERE 1=1';
  const params = [];

  if (type) { query += ' AND flag_type = ?'; params.push(type); }
  if (active !== undefined) { query += ' AND is_active = ?'; params.push(active === 'true' ? 1 : 0); }
  else { query += ' AND is_active = 1'; }

  query += ' ORDER BY flagged_on DESC';
  const flags = db.prepare(query).all(...params);

  // Stats
  const stats = db.prepare(`
    SELECT flag_type, COUNT(*) as count 
    FROM flagged_vehicles WHERE is_active = 1 
    GROUP BY flag_type
  `).all();

  const totalActive = db.prepare('SELECT COUNT(*) as count FROM flagged_vehicles WHERE is_active = 1').get().count;

  res.json({ flags, stats, totalActive });
});

// ──────────────────────────────────────────────
// POST /api/decode/flags — Add new flag
// ──────────────────────────────────────────────
router.post('/flags', (req, res) => {
  const db = getDb();
  const { plate, flag_type, severity, description, issuing_authority, case_number, expires_on } = req.body;

  if (!plate) return res.status(400).json({ error: 'Plate number is required' });
  if (!flag_type) return res.status(400).json({ error: 'Flag type is required' });

  const validTypes = ['stolen', 'wanted', 'expired_registration', 'traffic_violation', 'insurance_lapsed', 'tax_defaulter', 'suspicious', 'custom'];
  if (!validTypes.includes(flag_type)) {
    return res.status(400).json({ error: `Invalid flag_type. Must be one of: ${validTypes.join(', ')}` });
  }

  const result = db.prepare(`
    INSERT INTO flagged_vehicles (plate, flag_type, severity, description, issuing_authority, case_number, expires_on)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    String(plate).trim().toUpperCase(),
    flag_type,
    severity || 'warning',
    description || null,
    issuing_authority || null,
    case_number || null,
    expires_on || null,
  );

  const flag = db.prepare('SELECT * FROM flagged_vehicles WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(flag);
});

// ──────────────────────────────────────────────
// PUT /api/decode/flags/:id — Update a flag
// ──────────────────────────────────────────────
router.put('/flags/:id', (req, res) => {
  const db = getDb();
  const { severity, description, issuing_authority, case_number, is_active, expires_on } = req.body;

  const existing = db.prepare('SELECT * FROM flagged_vehicles WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Flag not found' });

  db.prepare(`
    UPDATE flagged_vehicles 
    SET severity = ?, description = ?, issuing_authority = ?, case_number = ?, is_active = ?, expires_on = ?
    WHERE id = ?
  `).run(
    severity || existing.severity,
    description !== undefined ? description : existing.description,
    issuing_authority !== undefined ? issuing_authority : existing.issuing_authority,
    case_number !== undefined ? case_number : existing.case_number,
    is_active !== undefined ? (is_active ? 1 : 0) : existing.is_active,
    expires_on !== undefined ? expires_on : existing.expires_on,
    req.params.id,
  );

  const updated = db.prepare('SELECT * FROM flagged_vehicles WHERE id = ?').get(req.params.id);
  res.json(updated);
});

// ──────────────────────────────────────────────
// DELETE /api/decode/flags/:id — Remove a flag
// ──────────────────────────────────────────────
router.delete('/flags/:id', (req, res) => {
  const db = getDb();
  db.prepare('UPDATE flagged_vehicles SET is_active = 0 WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ──────────────────────────────────────────────
// POST /api/decode/flags/bulk — Bulk import flags
// ──────────────────────────────────────────────
router.post('/flags/bulk', (req, res) => {
  const db = getDb();
  const { plates, flag_type, severity, description, issuing_authority } = req.body;

  if (!Array.isArray(plates) || plates.length === 0) {
    return res.status(400).json({ error: 'plates must be a non-empty array' });
  }

  const validTypes = ['stolen', 'wanted', 'expired_registration', 'traffic_violation', 'insurance_lapsed', 'tax_defaulter', 'suspicious', 'custom'];
  if (!validTypes.includes(flag_type)) {
    return res.status(400).json({ error: `Invalid flag_type` });
  }

  const insert = db.prepare(`
    INSERT INTO flagged_vehicles (plate, flag_type, severity, description, issuing_authority)
    VALUES (?, ?, ?, ?, ?)
  `);

  const insertMany = db.transaction((items) => {
    let count = 0;
    for (const plate of items) {
      const normalized = String(plate).trim().toUpperCase();
      if (!normalized) continue;
      insert.run(normalized, flag_type, severity || 'warning', description || null, issuing_authority || null);
      count++;
    }
    return count;
  });

  const count = insertMany(plates);
  res.status(201).json({ imported: count });
});

module.exports = router;
