// ============================================
// VisionTrack — Server Management API Routes
// GET/POST/PUT /api/servers
// POST /api/servers/:id/heartbeat
// ============================================
const express = require('express');
const router = express.Router();
const { getDb } = require('../database');
const { requireAuth, optionalAuth, getOrgCameraFilter } = require('../middleware/authMiddleware');

// --- GET /api/servers — List all servers (org-scoped) ---
router.get('/', requireAuth, (req, res) => {
  const db = getDb();
  const orgId = getOrgCameraFilter(req);

  let query = `
    SELECT s.*, o.name as organization_name, o.city as organization_city,
      (SELECT COUNT(*) FROM cameras c WHERE c.server_id = s.id) as camera_count
    FROM servers s
    JOIN organizations o ON s.organization_id = o.id
    WHERE 1=1
  `;
  const params = [];
  if (orgId) { query += ' AND s.organization_id = ?'; params.push(orgId); }
  query += ' ORDER BY s.organization_id, s.name';

  const servers = db.prepare(query).all(...params);

  // Don't expose full API tokens — show only last 8 chars
  const safe = servers.map(s => ({
    ...s,
    api_token: s.api_token ? `...${s.api_token.slice(-8)}` : null,
  }));

  res.json(safe);
});

// --- GET /api/servers/:id — Single server details ---
router.get('/:id', requireAuth, (req, res) => {
  const db = getDb();
  const orgId = getOrgCameraFilter(req);

  const server = db.prepare(`
    SELECT s.*, o.name as organization_name, o.city as organization_city
    FROM servers s
    JOIN organizations o ON s.organization_id = o.id
    WHERE s.id = ?
  `).get(req.params.id);

  if (!server) return res.status(404).json({ error: 'Server not found' });

  // Org-scoping
  if (orgId && server.organization_id !== orgId) {
    return res.status(403).json({ error: 'Access denied' });
  }

  // Get cameras assigned to this server
  const cameras = db.prepare(`
    SELECT id, name, city, zone, status, lat, lng FROM cameras WHERE server_id = ?
  `).all(req.params.id);

  // Mask token
  const safeToken = server.api_token ? `...${server.api_token.slice(-8)}` : null;

  res.json({
    ...server,
    api_token: safeToken,
    cameras,
    camera_count: cameras.length,
  });
});

// --- POST /api/servers — Create a new server ---
router.post('/', requireAuth, (req, res) => {
  const db = getDb();
  const { name, organization_id, endpoint_url, server_type } = req.body;

  // Only admin/super_admin can create servers
  if (!['admin', 'super_admin'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }

  // Validation
  if (!name || !endpoint_url) {
    return res.status(400).json({ error: 'Name and endpoint_url are required' });
  }

  // Determine org: admin can only create for their org
  const targetOrg = req.user.role === 'super_admin' && organization_id
    ? organization_id
    : req.user.organization_id;

  // Org-scoping check for non-super-admins
  if (req.user.role !== 'super_admin' && organization_id && organization_id !== req.user.organization_id) {
    return res.status(403).json({ error: 'Cannot create servers for other organizations' });
  }

  const { v4: uuidv4 } = require('uuid');
  const id = `SRV-${uuidv4().slice(0, 8).toUpperCase()}`;
  const apiToken = `srvtok_${id.toLowerCase()}_${uuidv4().replace(/-/g, '').substring(0, 24)}`;

  db.prepare(`
    INSERT INTO servers (id, organization_id, name, server_type, endpoint_url, api_token)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, targetOrg, name, server_type || 'city_anpr', endpoint_url, apiToken);

  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(id);
  res.status(201).json({
    ...server,
    api_token_full: apiToken, // Show full token only on creation
  });
});

// --- PUT /api/servers/:id — Update a server ---
router.put('/:id', requireAuth, (req, res) => {
  const db = getDb();

  // Only admin/super_admin can update servers
  if (!['admin', 'super_admin'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }

  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found' });

  // Org-scoping
  const orgId = getOrgCameraFilter(req);
  if (orgId && server.organization_id !== orgId) {
    return res.status(403).json({ error: 'Access denied' });
  }

  const { name, endpoint_url, status } = req.body;
  const updates = [];
  const params = [];

  if (name) { updates.push('name = ?'); params.push(name); }
  if (endpoint_url) { updates.push('endpoint_url = ?'); params.push(endpoint_url); }
  if (status) { updates.push('status = ?'); params.push(status); }

  if (updates.length === 0) {
    return res.status(400).json({ error: 'No fields to update' });
  }

  params.push(req.params.id);
  db.prepare(`UPDATE servers SET ${updates.join(', ')} WHERE id = ?`).run(...params);

  const updated = db.prepare(`
    SELECT s.*, o.name as organization_name
    FROM servers s JOIN organizations o ON s.organization_id = o.id
    WHERE s.id = ?
  `).get(req.params.id);

  res.json({
    ...updated,
    api_token: updated.api_token ? `...${updated.api_token.slice(-8)}` : null,
  });
});

// --- POST /api/servers/:id/heartbeat — Server health heartbeat ---
// This is authenticated via the server's API token, NOT user JWT
router.post('/:id/heartbeat', (req, res) => {
  const db = getDb();

  // Check for server API token in header
  const apiToken = req.headers['x-server-token'] || req.headers['authorization']?.replace('ServerToken ', '');
  if (!apiToken) {
    return res.status(401).json({ error: 'Server API token required' });
  }

  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found' });

  // Verify token matches
  if (server.api_token !== apiToken) {
    return res.status(401).json({ error: 'Invalid server API token' });
  }

  // Update last_seen and status
  db.prepare(`
    UPDATE servers SET status = 'online', last_seen = CURRENT_TIMESTAMP WHERE id = ?
  `).run(req.params.id);

  res.json({
    acknowledged: true,
    server_id: server.id,
    status: 'online',
    timestamp: new Date().toISOString(),
  });
});

module.exports = router;
