const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../database');
const { MediaEngine } = require('../services/mediaEngine');

const router = express.Router();
const mediaDir = path.join(__dirname, '..', 'uploads', 'media');
fs.mkdirSync(mediaDir, { recursive: true });
const upload = multer({
  dest: mediaDir,
  limits: { fileSize: Number(process.env.MEDIA_FILE_LIMIT_BYTES) || 2 * 1024 * 1024 * 1024 },
});
const engine = new MediaEngine();

router.get('/media/config', (req, res) => res.json({
  sample_fps: engine.options.sampleFps,
  dedup_window_ms: engine.options.dedupWindowMs,
  min_confidence: engine.options.minConfidence,
  ffmpeg: process.env.FFMPEG_PATH || 'ffmpeg',
}));

const { insertDetection } = require('../services/detectionPersistence');

function safeRecord(record) {
  if (!record) return null;
  const { child, reconnectTimer, input, tracker, ...safe } = record;
  return { ...safe, input: record.source === 'rtsp' ? '[redacted]' : input };
}

function wirePersistence(record) {
  // Finalized tracks are automatically persisted with full metadata (speed, violations,
  // snapshots, alerts) directly by the shared realtimeAnprPipeline.
  return record;
}

router.post('/video/jobs', upload.single('video'), (req, res) => {
  const input = req.file?.path || req.body?.input || req.body?.url;
  if (!input) return res.status(400).json({ error: 'video file or input is required' });
  const db = getDb();
  const defaultCam = db.prepare('SELECT id FROM cameras LIMIT 1').get();
  const cameraId = req.body?.camera_id || defaultCam?.id || 'CAM-001';

  const job = wirePersistence(engine.createVideoJob(input, {
    camera_id: cameraId,
    sampleFps: Number(req.body?.sample_fps) || undefined,
    dedupWindowMs: Number(req.body?.dedup_window_ms) || undefined,
  }));
  if (req.body?.start === 'true' || req.body?.start === true) engine.startVideoJob(job.id);
  return res.status(201).json({ job: safeRecord(job) });
});

router.get('/video/jobs', (req, res) => res.json({ jobs: [...engine.jobs.values()].map(safeRecord) }));
router.get('/video/jobs/:id', (req, res) => {
  const job = engine.jobs.get(req.params.id);
  return job ? res.json({ job: safeRecord(job) }) : res.status(404).json({ error: 'Video job not found' });
});
router.post('/video/jobs/:id/start', (req, res) => {
  const job = engine.startVideoJob(req.params.id);
  return job ? res.json({ job: safeRecord(job) }) : res.status(409).json({ error: 'Job cannot be started in its current state' });
});
router.post('/video/jobs/:id/stop', (req, res) => {
  const job = engine.stopVideoJob(req.params.id);
  return job ? res.json({ job: safeRecord(job) }) : res.status(404).json({ error: 'Video job not found' });
});

router.post('/rtsp/workers', (req, res) => {
  const input = String(req.body?.url || req.body?.input || '').trim();
  if (!/^(rtsps?|https?):\/\//i.test(input)) return res.status(400).json({ error: 'A valid rtsp://, rtsps://, or http:// URL is required' });
  const db = getDb();
  const defaultCam = db.prepare('SELECT id FROM cameras LIMIT 1').get();
  const cameraId = req.body?.camera_id || defaultCam?.id || 'CAM-001';

  const worker = wirePersistence(engine.createRtspWorker(input, {
    id: req.body?.id,
    camera_id: cameraId,
    sampleFps: Number(req.body?.sample_fps) || undefined,
    dedupWindowMs: Number(req.body?.dedup_window_ms) || undefined,
  }));
  if (req.body?.start !== false) engine.startRtspWorker(worker.id);
  return res.status(201).json({ worker: safeRecord(worker) });
});
router.get('/rtsp/workers', (req, res) => res.json({ workers: [...engine.workers.values()].map(safeRecord) }));
router.get('/rtsp/workers/:id', (req, res) => {
  const worker = engine.workers.get(req.params.id);
  return worker ? res.json({ worker: safeRecord(worker) }) : res.status(404).json({ error: 'RTSP worker not found' });
});
router.post('/rtsp/workers/:id/start', (req, res) => {
  const worker = engine.startRtspWorker(req.params.id);
  return worker ? res.json({ worker: safeRecord(worker) }) : res.status(409).json({ error: 'Worker cannot be started in its current state' });
});
router.post('/rtsp/workers/:id/stop', (req, res) => {
  const worker = engine.stopRtspWorker(req.params.id);
  return worker ? res.json({ worker: safeRecord(worker) }) : res.status(404).json({ error: 'RTSP worker not found' });
});

router.engine = engine;
module.exports = router;
