// ============================================
// VisionTrack — Network Virtual Camera Simulator
// Sends camera detections to each city server over HTTP instead of writing
// directly into the central SQLite database.
// ============================================
const http = require('http');
const { v4: uuidv4 } = require('uuid');
const { initializeDatabase, getDb } = require('../database');

const CITY_SERVER_ENDPOINTS = {
  'SRV-INDORE': 'http://localhost:3101/api/anpr/events',
  'SRV-PUNE': 'http://localhost:3102/api/anpr/events',
  'SRV-BHOPAL': 'http://localhost:3103/api/anpr/events',
};

const PLATES = [
  'MP09AB1234', 'MH12AB1234', 'DL01CA5678', 'KA05MN9012', 'TN22BH3456', 'UP32XY7890',
  'GJ06PQ2345', 'RJ14CD6789', 'WB26EF0123', 'AP09GH4567', 'TS08JK8901', 'HR26NO6789',
  'PB10RS0123', 'KL07TU4567', 'OR02VW8901', 'BR01AB2345', 'CG04CD6789', 'JH05EF0123',
  'UK07GH4567', 'GA08JK8901', 'MP09GG2109', 'MP04HH6543', 'MH43KK1357', 'DL12LL2468'
];

const VEHICLE_TYPES = ['car', 'truck', 'bus', 'motorcycle', 'van'];
const VEHICLE_COLORS = ['white', 'black', 'silver', 'red', 'blue', 'grey'];
const DIRECTIONS = ['north', 'south', 'east', 'west'];

function randomItem(items) {
  return items[Math.floor(Math.random() * items.length)];
}

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function getServerCameras() {
  initializeDatabase();
  const db = getDb();
  return db.prepare(`
    SELECT c.id, c.name, c.city, c.server_id, c.api_token, c.status,
      s.endpoint_url, s.organization_id
    FROM cameras c
    LEFT JOIN servers s ON c.server_id = s.id
    WHERE c.server_id IS NOT NULL AND c.api_token IS NOT NULL AND c.status = 'online'
    ORDER BY c.city, c.name
  `).all();
}

function getEndpointForServer(serverId) {
  return CITY_SERVER_ENDPOINTS[serverId] || `http://localhost:3101/api/anpr/events`;
}

function buildEvent(camera) {
  return {
    event_id: `evt-${uuidv4()}`,
    camera_id: camera.id,
    plate_number: randomItem(PLATES),
    timestamp: new Date().toISOString(),
    confidence: +(90 + Math.random() * 9.5).toFixed(1),
    vehicle_type: randomItem(VEHICLE_TYPES),
    vehicle_color: randomItem(VEHICLE_COLORS),
    speed: randomBetween(18, 78),
    direction: randomItem(DIRECTIONS),
  };
}

function sendEvent(event, camera) {
  let endpoint = camera.endpoint_url || getEndpointForServer(camera.server_id);
  if (!endpoint.includes('/api/anpr/events')) {
    endpoint = endpoint.replace(/\/$/, '') + '/api/anpr/events';
  }
  const payload = JSON.stringify(event);
  const url = new URL(endpoint);

  const options = {
    hostname: url.hostname,
    port: url.port,
    path: url.pathname,
    method: 'POST',
    timeout: 5000,
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
      'X-Camera-Id': camera.id,
      'X-Camera-Token': camera.api_token,
    },
  };

  return new Promise((resolve) => {
    const start = Date.now();
    const req = http.request(options, (res) => {
      let responseText = '';
      res.on('data', (chunk) => {
        responseText += chunk.toString();
      });
      res.on('end', () => {
        const success = res.statusCode >= 200 && res.statusCode < 300;
        const duration = Date.now() - start;
        if (success) {
          console.log(`✅ ${camera.id} → ${endpoint} [${res.statusCode}] ${duration}ms`);
        } else {
          console.warn(`⚠️ ${camera.id} rejected by city server [${res.statusCode}] ${responseText.slice(0, 140)}`);
        }
        resolve({ ok: success, statusCode: res.statusCode, body: responseText });
      });
    });

    req.on('timeout', () => {
      req.destroy(new Error('Request timeout'));
    });

    req.on('error', (err) => {
      console.warn(`⚠️ ${camera.id} network error: ${err.message}`);
      resolve({ ok: false, error: err.message });
    });

    req.write(payload);
    req.end();
  });
}

async function runNetworkSimulator() {
  console.log('📡 Starting network-based virtual camera simulator...');
  const cameras = getServerCameras();
  console.log(`   ${cameras.length} online cameras across ${new Set(cameras.map(c => c.city)).size} cities`);

  let tick = 0;
  setInterval(async () => {
    const activeCameras = getServerCameras().filter(c => c.status === 'online');
    if (!activeCameras.length) {
      console.log('ℹ️ No active camera connections available for network simulator');
      return;
    }

    const camera = activeCameras[Math.floor(Math.random() * activeCameras.length)];
    const event = buildEvent(camera);
    tick += 1;
    console.log(`📷 Simulated event ${tick} from ${camera.id} (${camera.city})`);
    await sendEvent(event, camera);
  }, 3500);

  return { getServerCameras };
}

if (require.main === module) {
  runNetworkSimulator();
}

module.exports = { runNetworkSimulator, sendEvent, buildEvent, getServerCameras };
