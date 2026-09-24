// ============================================
// VisionTrack — City Traffic Server Process
// Generic city server that connects to the central platform
// Usage: node server/city-servers/cityServer.js <server_id>
// ============================================
const express = require('express');
const http = require('http');

// --- Configuration from command line or environment ---
const SERVER_ID = process.argv[2] || process.env.CITY_SERVER_ID;
if (!SERVER_ID) {
  console.error('❌ Usage: node server/city-servers/cityServer.js <server_id>');
  console.error('   Example: node server/city-servers/cityServer.js SRV-INDORE');
  process.exit(1);
}

// Server configuration map
const SERVER_CONFIG = {
  'SRV-INDORE': { port: 3101, name: 'Indore Traffic Server', city: 'Indore' },
  'SRV-PUNE':   { port: 3102, name: 'Pune Traffic Server', city: 'Pune' },
  'SRV-BHOPAL': { port: 3103, name: 'Bhopal Traffic Server', city: 'Bhopal' },
};

const config = SERVER_CONFIG[SERVER_ID];
if (!config) {
  console.error(`❌ Unknown server ID: ${SERVER_ID}`);
  console.error(`   Valid IDs: ${Object.keys(SERVER_CONFIG).join(', ')}`);
  process.exit(1);
}

const PORT = process.env.CITY_PORT || config.port;
const CENTRAL_URL = process.env.CENTRAL_URL || 'http://localhost:3001';
const HEARTBEAT_INTERVAL = parseInt(process.env.HEARTBEAT_INTERVAL) || 30000; // 30 seconds

// --- Read API token from the central database ---
let API_TOKEN = process.env.SERVER_API_TOKEN || null;

function loadApiToken() {
  try {
    const { getDb, initializeDatabase } = require('../database');
    initializeDatabase();
    const db = getDb();
    const server = db.prepare('SELECT api_token FROM servers WHERE id = ?').get(SERVER_ID);
    if (server) {
      API_TOKEN = server.api_token;
      console.log(`🔑 API token loaded from database for ${SERVER_ID}`);
    } else {
      console.warn(`⚠️  Server ${SERVER_ID} not found in database. Run central server first.`);
    }
  } catch (err) {
    console.warn(`⚠️  Could not load API token from database: ${err.message}`);
    console.warn('   Set SERVER_API_TOKEN environment variable or ensure central DB is accessible.');
  }
}

loadApiToken();

// --- Express Setup ---
const app = express();
app.use(express.json({ limit: process.env.CAMERA_PAYLOAD_LIMIT || '50mb' }));

// --- Network flow: Camera -> City Server -> Central Platform ---
// Human auth: email + password
// Camera auth: camera_id + api_token
// City-server auth: server_id + secure server token
app.post('/api/anpr/events', (req, res) => {
  const { getDb } = require('../database');
  const db = getDb();
  const event = req.body || {};
  const cameraId = (event.camera_id || '').toString().trim();
  const suppliedToken = (req.headers['x-camera-token'] || '').toString().trim();

  if (!cameraId) {
    return res.status(400).json({ error: 'camera_id is required' });
  }

  const camera = db.prepare('SELECT * FROM cameras WHERE id = ?').get(cameraId);
  if (!camera) {
    return res.status(404).json({ error: 'Camera not found' });
  }

  if (camera.server_id !== SERVER_ID) {
    return res.status(403).json({ error: 'Camera is not assigned to this city server' });
  }

  if (camera.status !== 'online') {
    return res.status(403).json({ error: 'Camera is inactive' });
  }

  if (!camera.api_token) {
    return res.status(401).json({ error: 'Camera token not configured' });
  }

  if (!suppliedToken || suppliedToken !== camera.api_token) {
    return res.status(401).json({ error: 'Invalid camera token' });
  }

  if (!event.plate_number && !event.plate) {
    return res.status(400).json({ error: 'plate_number is required' });
  }

  if (!event.timestamp) {
    return res.status(400).json({ error: 'timestamp is required' });
  }

  const payload = {
    event_id: event.event_id || `evt-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    camera_id: camera.id,
    plate_number: event.plate_number || event.plate,
    timestamp: event.timestamp,
    confidence: Number(event.confidence ?? 0),
    vehicle_type: event.vehicle_type || event.vehicleType || 'unknown',
    vehicle_color: event.vehicle_color || event.vehicleColor || null,
    speed: event.speed !== undefined ? Number(event.speed) : null,
    direction: event.direction || null,
    server_id: SERVER_ID,
  };

  const forwardPayload = JSON.stringify(payload);
  const targetUrl = new URL(`/api/ingest/detection`, CENTRAL_URL);
  const options = {
    hostname: targetUrl.hostname,
    port: targetUrl.port,
    path: targetUrl.pathname,
    method: 'POST',
    timeout: 8000,
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(forwardPayload),
      'X-Server-Id': SERVER_ID,
      'X-Server-Token': API_TOKEN,
    },
  };

  const forwardReq = http.request(options, (forwardRes) => {
    let body = '';
    forwardRes.on('data', (chunk) => { body += chunk.toString(); });
    forwardRes.on('end', () => {
      if (forwardRes.statusCode >= 200 && forwardRes.statusCode < 300) {
        const parsed = (() => { try { return JSON.parse(body); } catch { return null; } })();
        return res.status(202).json({
          accepted: true,
          forwarded: true,
          server_id: SERVER_ID,
          camera_id: camera.id,
          event_id: payload.event_id,
          central_status: forwardRes.statusCode,
          duplicate: parsed && parsed.duplicate === true,
        });
      }

      return res.status(forwardRes.statusCode || 502).json({
        error: 'Central platform rejected event',
        details: body || 'Unknown error',
      });
    });
  });

  forwardReq.on('timeout', () => {
    forwardReq.destroy(new Error('City-to-central forwarding timeout'));
  });

  forwardReq.on('error', (err) => {
    console.warn(`⚠️ Event forwarding failed for ${cameraId}: ${err.message}`);
    return res.status(502).json({ error: 'Central platform unavailable', details: err.message });
  });

  forwardReq.write(forwardPayload);
  forwardReq.end();
});

// --- Health endpoint ---
app.get('/health', (req, res) => {
  res.json({
    server_id: SERVER_ID,
    name: config.name,
    city: config.city,
    status: 'online',
    uptime: process.uptime(),
    central_platform: CENTRAL_URL,
    timestamp: new Date().toISOString(),
  });
});

// --- Server info ---
app.get('/info', (req, res) => {
  res.json({
    server_id: SERVER_ID,
    organization_id: `ORG-${config.city.toUpperCase()}`,
    name: config.name,
    city: config.city,
    port: PORT,
    central_url: CENTRAL_URL,
    heartbeat_interval_ms: HEARTBEAT_INTERVAL,
    version: '1.0.0',
  });
});

// --- Root ---
app.get('/', (req, res) => {
  res.json({
    service: `${config.name} — VisionTrack`,
    status: 'online',
    endpoints: ['/health', '/info'],
  });
});

// --- Heartbeat to Central Platform ---
function sendHeartbeat() {
  if (!API_TOKEN) {
    console.warn('⚠️  No API token available, skipping heartbeat');
    return;
  }

  const url = new URL(`/api/servers/${SERVER_ID}/heartbeat`, CENTRAL_URL);
  const postData = JSON.stringify({ timestamp: new Date().toISOString() });

  const options = {
    hostname: url.hostname,
    port: url.port,
    path: url.pathname,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Server-Token': API_TOKEN,
      'Content-Length': Buffer.byteLength(postData),
    },
  };

  const req = http.request(options, (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      if (res.statusCode === 200) {
        console.log(`💓 Heartbeat OK → ${CENTRAL_URL} [${new Date().toISOString()}]`);
      } else {
        console.warn(`⚠️  Heartbeat failed: ${res.statusCode} — ${data}`);
      }
    });
  });

  req.on('error', (err) => {
    console.warn(`⚠️  Heartbeat error: ${err.message} (central platform may be offline)`);
  });

  req.write(postData);
  req.end();
}

// --- Start Server ---
const server = app.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════════════╗');
  console.log(`║   🏙️  ${config.name.padEnd(38)}  ║`);
  console.log('╠══════════════════════════════════════════════════╣');
  console.log(`║   Server ID:  ${SERVER_ID.padEnd(34)}║`);
  console.log(`║   City:       ${config.city.padEnd(34)}║`);
  console.log(`║   Port:       ${String(PORT).padEnd(34)}║`);
  console.log(`║   Central:    ${CENTRAL_URL.padEnd(34)}║`);
  console.log(`║   Heartbeat:  Every ${(HEARTBEAT_INTERVAL / 1000)}s${' '.repeat(28 - String(HEARTBEAT_INTERVAL / 1000).length)}║`);
  console.log('╚══════════════════════════════════════════════════╝');
  console.log('');

  // Send initial heartbeat
  sendHeartbeat();

  // Schedule periodic heartbeats
  setInterval(sendHeartbeat, HEARTBEAT_INTERVAL);
});

module.exports = { app };
