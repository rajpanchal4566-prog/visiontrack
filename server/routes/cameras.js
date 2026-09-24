const express = require('express');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const router = express.Router();
const { getDb } = require('../database');
const { optionalAuth, requireAuth, getOrgCameraFilter } = require('../middleware/authMiddleware');
const { getOrCreateRoute, recalculateRoutes } = require('../services/routeEngine');
const { RtspIngestion } = require('../services/rtspIngestion');

// Apply optional auth to all camera routes
router.use(optionalAuth);
const rtspIngestion = new RtspIngestion();

// External camera registration is authenticated with the organization's API key.
router.post('/register', (req, res) => {
  const db = getDb();
  const input = req.body || {};
  const apiKey = String(req.headers['x-api-key'] ?? input.api_key ?? '').trim();
  const name = String(input.camera_name ?? input.name ?? '').trim();
  const locationTag = String(input.location_tag ?? input.zone ?? '').trim();
  const latitude = Number(input.latitude ?? input.lat);
  const longitude = Number(input.longitude ?? input.lng);

  if (!apiKey) return res.status(401).json({ error: 'Organization API key is required' });
  if (!name || !locationTag || !Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return res.status(400).json({ error: 'camera_name, location_tag, latitude, and longitude are required' });
  }

  const organization = db.prepare(
    'SELECT id FROM organizations WHERE api_key = ? AND status = \'active\''
  ).get(apiKey);
  if (!organization) return res.status(401).json({ error: 'Invalid organization API key' });

  let id;
  let token;
  do {
    id = `CAM-${uuidv4().replace(/-/g, '').slice(0, 10).toUpperCase()}`;
  } while (db.prepare('SELECT 1 FROM cameras WHERE id = ?').get(id));
  do {
    token = `camtok_${crypto.randomBytes(24).toString('hex')}`;
  } while (db.prepare('SELECT 1 FROM cameras WHERE api_token = ?').get(token));

  db.prepare(`
    INSERT INTO cameras (id, name, city, lat, lng, zone, status, type, uptime, organization_id, api_token, endpoint_url, endpoint_status)
    VALUES (?, ?, ?, ?, ?, ?, 'online', ?, 99.0, ?, ?, ?, 'connected')
  `).run(
    id,
    name,
    input.city || 'Local',
    latitude,
    longitude,
    locationTag,
    input.type || 'metadata',
    organization.id,
    token,
    input.server_url || 'http://localhost:3001',
  );

  db.prepare('UPDATE cameras SET address = ?, road = ?, speed_limit_kmh = ? WHERE id = ?')
    .run(input.address || null, input.road || input.road_junction || null, Number.isFinite(Number(input.speed_limit_kmh)) ? Number(input.speed_limit_kmh) : null, id);

  return res.status(201).json({
    camera_id: id,
    camera_token: token,
    organization_id: organization.id,
  });
});

// POST /api/cameras — Create a new camera node from dashboard
router.post('/', (req, res) => {
  const db = getDb();
  const input = req.body || {};
  const name = String(input.name ?? input.camera_name ?? '').trim();
  const zone = String(input.zone ?? input.location_tag ?? '').trim();
  const city = String(input.city ?? 'Hyderabad').trim();
  const rawLat = input.lat !== undefined ? input.lat : input.latitude;
  const rawLng = input.lng !== undefined ? input.lng : input.longitude;
  const lat = Number(rawLat);
  const lng = Number(rawLng);

  if (!name) {
    return res.status(400).json({ error: 'camera_name / name is required' });
  }
  if (!zone) {
    return res.status(400).json({ error: 'location_tag / zone is required' });
  }
  if (rawLat === undefined || rawLat === null || rawLat === '' || !Number.isFinite(lat) || lat < -90 || lat > 90) {
    return res.status(400).json({ error: 'A valid latitude between -90 and 90 is required' });
  }
  if (rawLng === undefined || rawLng === null || rawLng === '' || !Number.isFinite(lng) || lng < -180 || lng > 180) {
    return res.status(400).json({ error: 'A valid longitude between -180 and 180 is required' });
  }

  const speedLimit = Number(input.speed_limit_kmh) || 50;
  const rtspUrl = input.rtsp_url ? String(input.rtsp_url).trim() : null;
  const transport = input.rtsp_transport || 'tcp';
  const sampleFps = Number(input.sample_fps) || 16.0;

  const defaultOrg = db.prepare('SELECT id FROM organizations LIMIT 1').get();
  const orgId = req.user?.organization_id || defaultOrg?.id || 'ORG-SYSTEM';

  let id;
  do {
    id = `CAM-${uuidv4().replace(/-/g, '').slice(0, 8).toUpperCase()}`;
  } while (db.prepare('SELECT 1 FROM cameras WHERE id = ?').get(id));

  db.prepare(`
    INSERT INTO cameras (
      id, name, city, lat, lng, zone, status, type, uptime, organization_id,
      speed_limit_kmh, rtsp_url, rtsp_transport, sample_fps,
      detect_helmet, detect_seatbelt, detect_speeding, address, road
    )
    VALUES (?, ?, ?, ?, ?, ?, 'online', 'both', 99.0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, name, city || 'Local', lat, lng, zone, orgId,
    speedLimit, rtspUrl, transport, sampleFps,
    input.detect_helmet !== undefined ? (input.detect_helmet ? 1 : 0) : 1,
    input.detect_seatbelt !== undefined ? (input.detect_seatbelt ? 1 : 0) : 1,
    input.detect_speeding !== undefined ? (input.detect_speeding ? 1 : 0) : 1,
    input.address || null, input.road || input.road_junction || null
  );

  const created = db.prepare('SELECT * FROM cameras WHERE id = ?').get(id);
  res.status(201).json(created);
});

// GET /api/cameras — List all cameras (org-scoped if authenticated)
router.get('/', (req, res) => {
  const db = getDb();
  const { city } = req.query;
  const orgId = getOrgCameraFilter(req);

  let query = `
    SELECT c.*,
      o.name as organization_name,
      ${req.user ? 'o.api_key as organization_api_key,' : ''}
      (SELECT COUNT(*) FROM detections d WHERE d.camera_id = c.id AND date(d.timestamp) = date('now')) as detections_today
    FROM cameras c
    LEFT JOIN organizations o ON o.id = c.organization_id
    WHERE 1=1
  `;
  const params = [];

  if (orgId) {
    query += ' AND c.organization_id IN (SELECT id FROM organizations WHERE id = ? OR parent_organization_id = ?)';
    params.push(orgId, orgId);
  }
  if (city) { query += ' AND c.city = ?'; params.push(city); }

  query += ' ORDER BY c.city, c.zone, c.name';
  const cameras = db.prepare(query).all(...params).map(camera => ({
    ...camera,
    stream_status: rtspIngestion.get(camera.id)?.state || 'disconnected',
  }));
  res.json(cameras);
});

// GET /api/cameras/cities — List distinct cities (org-scoped)
router.get('/cities', (req, res) => {
  const db = getDb();
  const orgId = getOrgCameraFilter(req);

  let query = 'SELECT DISTINCT city FROM cameras';
  const params = [];
  if (orgId) { query += ' WHERE organization_id = ?'; params.push(orgId); }
  query += ' ORDER BY city';

  const cities = db.prepare(query).all(...params);
  res.json(cities.map(c => c.city));
});

const RTSP_PRESETS = [
  { id: 'hikvision', name: 'Hikvision', template: 'rtsp://[username]:[password]@[ip]:554/Streaming/Channels/101', subTemplate: 'rtsp://[username]:[password]@[ip]:554/Streaming/Channels/102', port: 554, defaultTransport: 'tcp' },
  { id: 'dahua', name: 'Dahua / CP PLUS', template: 'rtsp://[username]:[password]@[ip]:554/cam/realmonitor?channel=1&subtype=0', subTemplate: 'rtsp://[username]:[password]@[ip]:554/cam/realmonitor?channel=1&subtype=1', port: 554, defaultTransport: 'tcp' },
  { id: 'uniview', name: 'Uniview (UNV)', template: 'rtsp://[username]:[password]@[ip]:554/media/video1', subTemplate: 'rtsp://[username]:[password]@[ip]:554/media/video2', port: 554, defaultTransport: 'tcp' },
  { id: 'axis', name: 'Axis Communications', template: 'rtsp://[username]:[password]@[ip]:554/axis-media/media.amp', subTemplate: 'rtsp://[username]:[password]@[ip]:554/axis-media/media.amp?camera=1', port: 554, defaultTransport: 'tcp' },
  { id: 'hanwha', name: 'Hanwha / Samsung', template: 'rtsp://[username]:[password]@[ip]:554/profile2/media.smp', subTemplate: 'rtsp://[username]:[password]@[ip]:554/profile3/media.smp', port: 554, defaultTransport: 'tcp' },
  { id: 'tapo', name: 'TP-Link Tapo', template: 'rtsp://[username]:[password]@[ip]:554/stream1', subTemplate: 'rtsp://[username]:[password]@[ip]:554/stream2', port: 554, defaultTransport: 'tcp' },
  { id: 'reolink', name: 'Reolink', template: 'rtsp://[username]:[password]@[ip]:554/h264Preview_01_main', subTemplate: 'rtsp://[username]:[password]@[ip]:554/h264Preview_01_sub', port: 554, defaultTransport: 'tcp' },
  { id: 'generic', name: 'Generic RTSP / ONVIF', template: 'rtsp://[username]:[password]@[ip]:554/live/ch0', subTemplate: 'rtsp://[username]:[password]@[ip]:554/live/ch1', port: 554, defaultTransport: 'tcp' },
  { id: 'mobile_ipwebcam', name: 'Mobile (IP Webcam Android)', template: 'http://[ip]:8080/video', subTemplate: 'rtsp://[ip]:8080/h264_pcm.sdp', port: 8080, defaultTransport: 'tcp' },
  { id: 'mobile_rtsp', name: 'Mobile (RTSP Camera App)', template: 'rtsp://[ip]:8554/live', subTemplate: 'rtsp://[ip]:8554/live', port: 8554, defaultTransport: 'tcp' },
  { id: 'mobile_droidcam', name: 'Mobile (DroidCam)', template: 'http://[ip]:4747/mjpegfeed', subTemplate: 'http://[ip]:4747/video', port: 4747, defaultTransport: 'tcp' },
];

// GET /api/cameras/presets — Common manufacturer RTSP presets
router.get('/presets', (req, res) => {
  res.json(RTSP_PRESETS);
});

// POST /api/cameras/test-stream — Test connectivity to an RTSP camera stream
router.post('/test-stream', async (req, res) => {
  const url = String(req.body?.url || req.body?.rtsp_url || '').trim();
  const transport = req.body?.transport || 'tcp';
  if (!/^(rtsps?|https?):\/\//i.test(url)) {
    return res.status(400).json({ error: 'A valid rtsp://, rtsps://, or http:// stream URL is required' });
  }

  try {
    const result = await RtspIngestion.testConnection(url, { transport });
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/cameras/streams/status — Real-time multi-camera capacity and stream health
router.get('/streams/status', (req, res) => {
  try {
    const info = rtspIngestion.getCapacityInfo();
    res.json(info);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/cameras/streams/connect-all — Bulk start all cameras with valid RTSP URLs
router.post('/streams/connect-all', async (req, res) => {
  const db = getDb();
  const orgId = getOrgCameraFilter(req);
  let query = 'SELECT * FROM cameras WHERE rtsp_url IS NOT NULL AND length(trim(rtsp_url)) > 0';
  const params = [];
  if (orgId) {
    query += ' AND (organization_id = ? OR organization_id IN (SELECT id FROM organizations WHERE parent_organization_id = ?))';
    params.push(orgId, orgId);
  }
  const camerasWithRtsp = db.prepare(query).all(...params);

  const results = [];
  for (const cam of camerasWithRtsp) {
    try {
      const sampleFps = Number(cam.sample_fps) > 0 ? Number(cam.sample_fps) : 16.0;
      const worker = await rtspIngestion.start(cam.id, cam.rtsp_url, {
        transport: cam.rtsp_transport || 'tcp',
        sampleFps,
      });
      results.push({ camera_id: cam.id, name: cam.name, success: true, stream: worker });
    } catch (err) {
      results.push({ camera_id: cam.id, name: cam.name, success: false, error: err.message });
    }
  }

  res.json({
    totalConfigured: camerasWithRtsp.length,
    started: results.filter(r => r.success).length,
    results,
    capacity: rtspIngestion.getCapacityInfo(),
  });
});

// POST /api/cameras/streams/disconnect-all — Bulk stop all active RTSP streams
router.post('/streams/disconnect-all', (req, res) => {
  const stopped = rtspIngestion.stopAll();
  res.json({
    stoppedCount: stopped.length,
    capacity: rtspIngestion.getCapacityInfo(),
  });
});

router.post('/:id/connect-stream', async (req, res) => {
  const db = getDb();
  const orgId = getOrgCameraFilter(req);
  const camera = db.prepare('SELECT * FROM cameras WHERE id = ?').get(req.params.id);
  const url = String(req.body?.url || req.body?.rtsp_url || camera?.rtsp_url || '').trim();
  const transport = req.body?.transport || camera?.rtsp_transport || 'tcp';
  const rawFps = req.body?.sample_fps ?? req.body?.sampleFps ?? camera?.sample_fps;
  const sampleFps = Number(rawFps) > 0 ? Number(rawFps) : 16.0;

  if (!camera) return res.status(404).json({ error: 'Camera not found' });
  if (orgId && camera.organization_id !== orgId) return res.status(403).json({ error: 'Access denied' });
  if (!/^(rtsps?|https?):\/\//i.test(url)) return res.status(400).json({ error: 'A valid rtsp://, rtsps://, or http:// stream URL is required' });

  try {
    const worker = await rtspIngestion.start(camera.id, url, { transport, sampleFps });
    // Persist RTSP URL & configuration in camera record
    db.prepare('UPDATE cameras SET rtsp_url = ?, rtsp_transport = ?, sample_fps = ? WHERE id = ?')
      .run(url, transport, worker.sampleFps || 4.0, camera.id);

    return res.status(202).json({ connected: true, camera_id: camera.id, stream: worker });
  } catch (error) {
    const status = error.code === 'FFMPEG_UNAVAILABLE' ? 503 : 400;
    return res.status(status).json({ error: error.message, code: error.code || 'STREAM_START_FAILED' });
  }
});

router.post('/:id/disconnect-stream', (req, res) => {
  const db = getDb();
  const orgId = getOrgCameraFilter(req);
  const camera = db.prepare('SELECT * FROM cameras WHERE id = ?').get(req.params.id);
  if (!camera) return res.status(404).json({ error: 'Camera not found' });
  if (orgId && camera.organization_id !== orgId) return res.status(403).json({ error: 'Access denied' });
  const stream = rtspIngestion.stop(camera.id);
  return res.json({ connected: false, camera_id: camera.id, stream: stream || { state: 'disconnected' } });
});

// GET /api/cameras/:id/connections — Nearby cached/plausible camera transitions
router.get('/:id/connections', async (req, res) => {
  const db = getDb();
  const orgId = getOrgCameraFilter(req);
  const camera = db.prepare('SELECT * FROM cameras WHERE id = ?').get(req.params.id);
  if (!camera) return res.status(404).json({ error: 'Camera not found' });
  if (orgId && camera.organization_id !== orgId) return res.status(403).json({ error: 'Access denied' });

  let cameras = db.prepare('SELECT * FROM cameras WHERE id != ? ORDER BY city, zone, name').all(camera.id);
  if (orgId) cameras = cameras.filter(item => item.organization_id === orgId);
  const connections = [];
  for (const target of cameras) {
    const route = await getOrCreateRoute(camera, target, { db });
    if (route.route_status !== 'unavailable') connections.push({ ...route, camera: target });
  }
  connections.sort((first, second) => (first.estimated_travel_time_seconds || Infinity) - (second.estimated_travel_time_seconds || Infinity));
  res.json({ camera, connections });
});

// GET /api/cameras/:id/routes — Alias with route metadata for network clients
router.get('/:id/routes', async (req, res) => {
  const db = getDb();
  const camera = db.prepare('SELECT * FROM cameras WHERE id = ?').get(req.params.id);
  if (!camera) return res.status(404).json({ error: 'Camera not found' });
  const routes = db.prepare('SELECT * FROM camera_routes WHERE from_camera_id = ? ORDER BY estimated_travel_time_seconds').all(camera.id);
  res.json(routes);
});

// POST /api/cameras/routes/recalculate — Explicitly refresh the camera graph
router.post('/routes/recalculate', async (req, res) => {
  const db = getDb();
  const orgId = getOrgCameraFilter(req);
  const cameras = db.prepare('SELECT * FROM cameras ORDER BY id').all().filter(camera => !orgId || camera.organization_id === orgId);
  const routes = await recalculateRoutes(cameras, { db });
  res.json({ recalculated: routes.length, routes });
});

// GET /api/cameras/:id — Single camera with recent detections
router.get('/:id', (req, res) => {
  const db = getDb();
  const orgId = getOrgCameraFilter(req);

  const camera = db.prepare(`
    SELECT c.*, ${req.user ? 'o.api_key as organization_api_key' : 'NULL as organization_api_key'}
    FROM cameras c
    LEFT JOIN organizations o ON o.id = c.organization_id
    WHERE c.id = ?
  `).get(req.params.id);
  if (!camera) return res.status(404).json({ error: 'Camera not found' });

  // Org-scoping check
  if (orgId && camera.organization_id !== orgId) {
    return res.status(403).json({ error: 'Access denied' });
  }

  const recentDetections = db.prepare(`
    SELECT * FROM detections WHERE camera_id = ? ORDER BY timestamp DESC LIMIT 20
  `).all(req.params.id);

  res.json({
    ...camera,
    connection: req.user && camera.organization_api_key ? {
      camera_id: camera.id,
      api_key: camera.organization_api_key,
      server_url: 'http://localhost:3001',
      ingest_endpoint: '/api/detections/ingest',
    } : null,
    recentDetections,
  });
});

// PUT /api/cameras/:id — Update camera status
router.put('/:id', (req, res) => {
  const db = getDb();
  const {
    name, zone, city,
    status, latitude, longitude, lat, lng, address, road, road_junction,
    speed_limit_kmh, rtsp_url, rtsp_transport, sample_fps,
    detect_helmet, detect_seatbelt, detect_speeding,
  } = req.body;
  if (status !== undefined && !['online', 'offline', 'degraded'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }

  const orgId = getOrgCameraFilter(req);
  if (orgId) {
    const camera = db.prepare('SELECT organization_id FROM cameras WHERE id = ?').get(req.params.id);
    if (camera && camera.organization_id !== orgId) {
      return res.status(403).json({ error: 'Access denied' });
    }
  }

  const current = db.prepare('SELECT * FROM cameras WHERE id = ?').get(req.params.id);
  if (!current) return res.status(404).json({ error: 'Camera not found' });
  const nextName = name !== undefined ? String(name).trim() : current.name;
  const nextZone = zone !== undefined ? String(zone).trim() : current.zone;
  const nextCity = city !== undefined ? String(city).trim() : current.city;
  const nextLat = latitude ?? lat ?? current.lat;
  const nextLng = longitude ?? lng ?? current.lng;
  if (!Number.isFinite(Number(nextLat)) || Number(nextLat) < -90 || Number(nextLat) > 90) {
    return res.status(400).json({ error: 'Valid latitude between -90 and 90 is required' });
  }
  if (!Number.isFinite(Number(nextLng)) || Number(nextLng) < -180 || Number(nextLng) > 180) {
    return res.status(400).json({ error: 'Valid longitude between -180 and 180 is required' });
  }
  const locationChanged = Number(nextLat) !== Number(current.lat) || Number(nextLng) !== Number(current.lng);
  db.prepare(`
    UPDATE cameras
    SET name = ?, zone = ?, city = ?, status = ?, lat = ?, lng = ?, address = ?, road = ?, speed_limit_kmh = ?,
        rtsp_url = ?, rtsp_transport = ?, sample_fps = ?,
        detect_helmet = ?, detect_seatbelt = ?, detect_speeding = ?
    WHERE id = ?
  `).run(
    nextName || current.name,
    nextZone || current.zone,
    nextCity || current.city,
    status ?? current.status,
    Number(nextLat),
    Number(nextLng),
    address ?? current.address,
    road ?? road_junction ?? current.road,
    speed_limit_kmh !== undefined ? (Number(speed_limit_kmh) || null) : current.speed_limit_kmh,
    rtsp_url !== undefined ? (rtsp_url ? String(rtsp_url).trim() : null) : current.rtsp_url,
    rtsp_transport !== undefined ? rtsp_transport : (current.rtsp_transport || 'tcp'),
    sample_fps !== undefined ? Number(sample_fps) : (current.sample_fps || 2.0),
    detect_helmet !== undefined ? (detect_helmet ? 1 : 0) : (current.detect_helmet ?? 1),
    detect_seatbelt !== undefined ? (detect_seatbelt ? 1 : 0) : (current.detect_seatbelt ?? 1),
    detect_speeding !== undefined ? (detect_speeding ? 1 : 0) : (current.detect_speeding ?? 1),
    req.params.id,
  );
  if (locationChanged) {
    db.prepare('DELETE FROM camera_routes WHERE from_camera_id = ? OR to_camera_id = ?').run(req.params.id, req.params.id);
  }
  const camera = db.prepare('SELECT * FROM cameras WHERE id = ?').get(req.params.id);
  res.json(camera);
});

module.exports = router;
