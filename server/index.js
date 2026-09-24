// ============================================
// VisionTrack — Central AI Engine Server
// Express + Socket.IO + Virtual Camera Simulator
// ============================================
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const { initializeDatabase, seedDatabase, DB_PATH } = require('./database');
const { JWT_SECRET } = require('./middleware/authMiddleware');

// --- Import Routes ---
const camerasRouter = require('./routes/cameras');
const detectionsRouter = require('./routes/detections');
const vehiclesRouter = require('./routes/vehicles');
const watchlistRouter = require('./routes/watchlist');
const alertsRouter = require('./routes/alerts');
const analyticsRouter = require('./routes/analytics');
const authRouter = require('./routes/auth');
const serversRouter = require('./routes/servers');
const ingestRouter = require('./routes/ingest');
const decodeRouter = require('./routes/decode');
const travelRouter = require('./routes/travel');
const organizationsRouter = require('./routes/organizations');
const ocrRouter = require('./routes/ocr');
const mediaRouter = require('./routes/media');

// --- Initialize Express ---
const app = express();
const server = http.createServer(app);
const cameraPayloadLimit = process.env.CAMERA_PAYLOAD_LIMIT || '50mb';

function isAllowedOrigin(origin) {
  if (!origin) return true;
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return true;

  // Support ALLOWED_ORIGINS, CORS_ORIGIN, or CORS_ALLOWED_ORIGINS
  const configured = (process.env.ALLOWED_ORIGINS || process.env.CORS_ORIGIN || process.env.CORS_ALLOWED_ORIGINS || '').trim();
  if (configured === '*') return true;

  const extraOrigins = configured
    .split(',')
    .map((value) => value.trim().replace(/\/$/, ''))
    .filter(Boolean);

  const normalizedOrigin = origin.replace(/\/$/, '');
  return extraOrigins.includes(normalizedOrigin);
}

// --- Socket.IO ---
const io = new Server(server, {
  cors: {
    origin: (origin, callback) => callback(null, isAllowedOrigin(origin)),
    methods: ['GET', 'POST'],
    credentials: true,
  },
});
app.set('io', io);
global.io = io;

// --- Middleware ---
app.use(cors({
  origin: (origin, callback) => callback(null, isAllowedOrigin(origin)),
  credentials: true,
}));
app.use(express.json({ limit: cameraPayloadLimit }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
// Keep previously stored project-level uploads accessible during migration.
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));

// --- Request Logging ---
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    if (req.method !== 'OPTIONS') {
      console.log(`${req.method} ${req.path} ${res.statusCode} ${duration}ms`);
    }
  });
  next();
});

// --- API Routes ---
app.use('/api/auth', authRouter);
app.use('/api/organizations', organizationsRouter);
app.use('/api/cameras', camerasRouter);
app.use('/api/detections', detectionsRouter);
app.use('/api/vehicles', vehiclesRouter);
app.use('/api/watchlist', watchlistRouter);
app.use('/api/alerts', alertsRouter);
app.use('/api/analytics', analyticsRouter);
app.use('/api/servers', serversRouter);
app.use('/api/ingest', ingestRouter);
app.use('/api/decode', decodeRouter);
app.use('/api/ocr', ocrRouter);
// Unified video-file and RTSP frame ingestion. Existing camera/detection APIs
// remain the canonical persistence path; this route only supplies frames.
app.use('/api', mediaRouter);
app.use('/api/media', mediaRouter);
app.use('/api', travelRouter);

// --- Health Check ---
app.get('/health', (req, res) => {
  res.json({
    status: 'online',
    service: 'visiontrack-server',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'online',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    version: '1.0.0',
  });
});

// --- Socket.IO Connection ---
io.on('connection', (socket) => {
  console.log(`🔌 Client connected: ${socket.id}`);

  const token = socket.handshake.auth?.token
    || String(socket.handshake.headers?.authorization || '').replace(/^Bearer\s+/i, '');
  if (token) {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      if (decoded.organization_id) socket.join(decoded.organization_id);
    } catch (err) {
      console.warn(`⚠️ Socket auth failed for ${socket.id}`);
    }
  }

  socket.on('disconnect', () => {
    console.log(`🔌 Client disconnected: ${socket.id}`);
  });
});

// --- Serve Frontend Static Build if Present ---
const distPath = path.join(__dirname, '..', 'dist');
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
  app.use((req, res, next) => {
    if (req.method === 'GET' && !req.path.startsWith('/api') && !req.path.startsWith('/uploads') && !req.path.startsWith('/socket.io')) {
      return res.sendFile(path.join(distPath, 'index.html'));
    }
    next();
  });
}

// --- Start Server ---
const PORT = process.env.PORT || 3001;

// Initialize database
initializeDatabase();
seedDatabase();

server.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║   🧠 VisionTrack Traffic Intelligence       ║');
  console.log('╠══════════════════════════════════════════════╣');
  console.log(`║   Server:    http://localhost:${PORT}           ║`);
  console.log(`║   Database:  SQLite (${path.basename(DB_PATH)})            ║`);
  console.log('║   WebSocket: Socket.IO                       ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log('');

  // The simulator remains available as a backup, but is not started automatically.
});

module.exports = { app, io };
