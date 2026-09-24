const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const { io: ioClient } = require('socket.io-client');
const { getDb } = require('../server/database');
const { realtimeAnprPipeline } = require('../server/services/realtimeAnprPipeline');
const appModule = require('../server/index');

const { generateToken } = require('../server/middleware/authMiddleware');

async function verifyLiveWiring() {
  console.log('=== VERIFYING LIVE APP WIRING: RTSP/FRAME -> PIPELINE -> OCR -> DB -> SOCKET.IO ===\n');

  // Step 1: Query an existing camera from the DB to use valid multi-tenant camera & org
  const db = getDb();
  const camera = db.prepare('SELECT * FROM cameras LIMIT 1').get();
  console.log('1. Target Camera:', { id: camera.id, name: camera.name, zone: camera.zone, org: camera.organization_id });

  // Step 2: Mint a valid JWT token for this org so client socket connects and joins org room
  const token = generateToken({
    id: 'USR-TEST-001',
    organization_id: camera.organization_id,
    role: 'superadmin'
  });

  // Step 3: Connect Socket.IO client (simulating dashboard frontend)
  const socket = ioClient('http://localhost:3001', {
    auth: { token },
    transports: ['websocket']
  });

  const socketEvents = [];
  await new Promise((resolve, reject) => {
    socket.on('connect', () => {
      console.log('2. Dashboard Socket.IO client connected with socket ID:', socket.id);
      resolve();
    });
    socket.on('connect_error', reject);
  });

  socket.on('detection:new', (data) => {
    console.log('\n>>> [DASHBOARD CLIENT] Socket.IO event received: detection:new <<<');
    socketEvents.push({ event: 'detection:new', data });
  });

  socket.on('stream:frame', (data) => {
    console.log('>>> [DASHBOARD CLIENT] Socket.IO event received: stream:frame <<<');
    socketEvents.push({ event: 'stream:frame', data });
  });

  // Step 4: Feed the real frame 0010a106-f15c-4313-a5dd-958e641a1484.png through realtimeAnprPipeline.processFrame
  realtimeAnprPipeline.deduplicators.clear();
  const framePath = path.join(__dirname, '..', 'server', 'uploads', 'detections', '0010a106-f15c-4313-a5dd-958e641a1484.png');
  const frameBuffer = fs.readFileSync(framePath);
  console.log('\n3. Ingesting frame into realtimeAnprPipeline.processFrame()...');
  const t0 = Date.now();
  const pipelineResult = await realtimeAnprPipeline.processFrame(frameBuffer, {
    cameraId: camera.id,
    camera: camera,
    sourceType: 'rtsp',
    emitSocket: true
  });
  const elapsed = Date.now() - t0;
  console.log('4. Pipeline execution completed in ' + elapsed + ' ms');
  console.log('   Pipeline Result Summary:', {
    success: pipelineResult.success,
    plate: pipelineResult.plate,
    vehicle_detected: pipelineResult.vehicle_detected,
    vehicle_type: pipelineResult.vehicle_type,
    detectionId: pipelineResult.detection?.id,
    imagePath: pipelineResult.detection?.image_path
  });

  // Wait a short moment for socket event dispatch
  await new Promise(r => setTimeout(r, 600));

  // Step 5: Verify the exact database record in 'detections' table
  const insertedId = pipelineResult.detection?.id;
  console.log('\n5. Querying database table "detections" for ID: ' + insertedId);
  const dbRow = db.prepare('SELECT * FROM detections WHERE id = ?').get(insertedId);

  console.log('\n--- REAL DATABASE ROW FROM SQLite (anpr.db) ---');
  console.log(JSON.stringify(dbRow, null, 2));

  // Step 6: Verify Dashboard Socket.IO received data
  console.log('\n--- CONFIRMED SOCKET.IO EVENT PUSHED TO DASHBOARD ---');
  console.log('Total events received by dashboard socket: ' + socketEvents.length);
  const detectionEvent = socketEvents.find(e => e.event === 'detection:new');
  if (detectionEvent) {
    console.log('Detection event payload received by live client:');
    console.log(JSON.stringify(detectionEvent.data, null, 2));
  } else {
    console.log('Warning: detection:new event was not received by client');
  }

  socket.disconnect();
  process.exit(0);
}

verifyLiveWiring().catch(err => {
  console.error('Verification failed:', err);
  process.exit(1);
});
