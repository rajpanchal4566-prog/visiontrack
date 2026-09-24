const { spawn, spawnSync } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../database');
const { processPlateImage } = require('./ocrService');
const { insertDetection } = require('./detectionPersistence');
const { updateTrafficStats, checkWatchlist } = require('../simulator/virtualCamera');
const { realtimeAnprPipeline } = require('./realtimeAnprPipeline');

const DEFAULT_INTERVAL_MS = 65; // ~15-16 frames per second (65ms interval for high-speed 15-16 FPS operation)
const DEFAULT_MAX_RETRIES = 5;

function ffmpegPath() { return process.env.FFMPEG_PATH || 'ffmpeg'; }

function assertFfmpegAvailable() {
  const result = spawnSync(ffmpegPath(), ['-version'], { stdio: 'ignore', windowsHide: true });
  if (result.error || result.status !== 0) {
    const error = new Error(`ffmpeg is not available at "${ffmpegPath()}". Install ffmpeg or set FFMPEG_PATH.`);
    error.code = 'FFMPEG_UNAVAILABLE';
    throw error;
  }
}

function extractJpegs(buffer, onFrame) {
  let pending = buffer;
  while (true) {
    const start = pending.indexOf(Buffer.from([0xff, 0xd8]));
    if (start < 0) return pending.length > 2 ? pending.slice(-2) : pending;
    const end = pending.indexOf(Buffer.from([0xff, 0xd9]), start + 2);
    if (end < 0) return pending.slice(start);
    onFrame(pending.slice(start, end + 2));
    pending = pending.slice(end + 2);
  }
}

class RtspIngestion {
  constructor(options = {}) {
    this.workers = new Map();
    const envInterval = Number(process.env.FRAME_SAMPLE_INTERVAL_MS || process.env.RTSP_FRAME_INTERVAL_MS);
    this.intervalMs = Number.isFinite(envInterval) && envInterval >= 100
      ? envInterval
      : (Number(options.intervalMs) || DEFAULT_INTERVAL_MS);
    this.maxRetries = Number(options.maxRetries || process.env.RTSP_MAX_RETRIES) || DEFAULT_MAX_RETRIES;
  }

  get(cameraId) { return this.workers.get(cameraId) || null; }

  getAll() {
    return Array.from(this.workers.values()).map(w => this.safe(w));
  }

  getOptimalFps(requestedFps = null) {
    if (requestedFps && Number(requestedFps) > 0) {
      return Number(requestedFps);
    }
    // Dynamic adaptive FPS based on active camera count:
    // 1 cam -> 6 FPS; 2 cams -> 3.5 FPS; 4 cams -> 2 FPS; 6 cams -> 1.2 FPS
    const targetSystemFps = Number(process.env.MAX_PIPELINE_TOTAL_FPS) || 8.0;
    const count = Math.max(1, this.workers.size + 1);
    const calculated = targetSystemFps / count;
    return Math.max(1.0, Math.min(6.0, Number(calculated.toFixed(1))));
  }

  getCapacityInfo() {
    const activeStreams = this.workers.size;
    const maxRecommended = 4;
    const targetSystemFps = Number(process.env.MAX_PIPELINE_TOTAL_FPS) || 8.0;
    const currentTotalFps = Array.from(this.workers.values()).reduce(
      (sum, w) => sum + (w.processedFps || w.sampleFps || 0), 0
    );
    return {
      activeStreams,
      maxRecommended,
      targetSystemFps,
      currentTotalFps: Number(currentTotalFps.toFixed(1)),
      utilizationPercent: Math.min(100, Math.round((currentTotalFps / targetSystemFps) * 100)),
      status: activeStreams === 0 ? 'idle' : activeStreams <= maxRecommended ? 'optimal' : 'heavy_load',
      streams: this.getAll(),
    };
  }

  async start(cameraId, url, options = {}) {
    assertFfmpegAvailable();
    if (this.workers.has(cameraId)) this.stop(cameraId);
    const sampleFps = options.sampleFps || Math.max(0.2, 1000 / this.intervalMs);
    const worker = {
      cameraId,
      url,
      transport: options.transport || 'tcp',
      sampleFps,
      state: 'starting',
      retries: 0,
      frames: 0,
      detections: 0,
      processedFps: 0,
      lastFrameTime: 0,
      lastError: null,
      startedAt: new Date().toISOString(),
      child: null,
      retryTimer: null,
      lastDetection: null,
    };
    this.workers.set(cameraId, worker);
    this.#spawn(worker);
    return this.safe(worker);
  }

  stop(cameraId) {
    const worker = this.workers.get(cameraId);
    if (!worker) return null;
    worker.state = 'stopping';
    if (worker.retryTimer) clearTimeout(worker.retryTimer);
    if (worker.child) worker.child.kill('SIGTERM');
    this.workers.delete(cameraId);
    realtimeAnprPipeline.finalizeCamera(cameraId).catch(() => {});
    console.log(`[RTSP] Stopped camera ${cameraId}`);
    return this.safe(worker);
  }

  stopAll() {
    const cameraIds = Array.from(this.workers.keys());
    const stopped = [];
    for (const id of cameraIds) {
      stopped.push(this.stop(id));
    }
    return stopped;
  }

  safe(worker) {
    const { child, retryTimer, url, ...safe } = worker;
    return { ...safe, connected: safe.state === 'running' || safe.state === 'starting' };
  }

  #spawn(worker) {
    const frameRate = worker.sampleFps || Math.max(0.2, 1000 / this.intervalMs);
    const transport = worker.transport || 'tcp';
    const isHttp = /^https?:\/\//i.test(worker.url);
    const ffmpegArgs = ['-hide_banner', '-loglevel', 'error'];
    if (!isHttp) {
      ffmpegArgs.push('-rtsp_transport', transport);
      ffmpegArgs.push('-timeout', '5000000');
    }
    ffmpegArgs.push(
      '-i', worker.url,
      '-vf', `fps=${frameRate},scale='if(gt(iw,1920),1920,iw)':-2`,
      '-f', 'image2pipe',
      '-vcodec', 'mjpeg',
      '-q:v', '3',
      'pipe:1',
    );
    const child = spawn(ffmpegPath(), ffmpegArgs, { windowsHide: true });

    worker.child = child;
    let pending = Buffer.alloc(0);

    child.stdout.on('data', chunk => {
      pending = extractJpegs(Buffer.concat([pending, chunk]), frame => this.#processFrame(worker, frame));
    });

    child.stderr.on('data', chunk => {
      const errStr = chunk.toString().trim();
      if (errStr) worker.lastError = errStr.slice(-500);
    });

    child.on('error', error => this.#drop(worker, error));
    child.on('close', code => {
      if (worker.state === 'stopping' || !this.workers.has(worker.cameraId) || worker.child !== child) return;
      this.#drop(worker, new Error(worker.lastError || `ffmpeg exited with code ${code}`));
    });
  }

  async #processFrame(worker, frame) {
    if (worker.state === 'stopping' || worker.busy) return;
    worker.busy = true;
    worker.state = 'running';
    worker.frames += 1;

    const now = Date.now();
    if (worker.lastFrameTime > 0) {
      const dtSec = (now - worker.lastFrameTime) / 1000;
      if (dtSec > 0 && dtSec < 5) {
        const instantFps = 1 / dtSec;
        worker.processedFps = worker.processedFps > 0
          ? Number((worker.processedFps * 0.75 + instantFps * 0.25).toFixed(1))
          : Number(instantFps.toFixed(1));
      }
    }
    worker.lastFrameTime = now;

    if (worker.retries > 0) {
      console.log(`[RTSP] Stream recovered for ${worker.cameraId} (after ${worker.retries} retries)`);
      worker.retries = 0;
    }

    try {
      const db = getDb();
      const camera = db.prepare('SELECT * FROM cameras WHERE id = ?').get(worker.cameraId);

      const result = await realtimeAnprPipeline.processFrame(frame, {
        camera,
        cameraId: worker.cameraId,
        sourceType: 'rtsp',
        emitSocket: true,
      });

      if (result.plate) {
        worker.detections += 1;
        worker.lastDetection = {
          plate: result.plate,
          vehicle_type: result.vehicle_type,
          violations: result.violations,
          timestamp: new Date().toISOString(),
        };
      }
    } catch (error) {
      worker.lastError = error.message;
      console.warn(`[RTSP] Pipeline error for ${worker.cameraId}: ${error.message}`);
    } finally {
      worker.busy = false;
    }
  }

  #drop(worker, error) {
    if (worker.state === 'stopping' || !this.workers.has(worker.cameraId)) return;
    worker.child = null;
    worker.lastError = error.message;
    worker.retries += 1;
    console.warn(`[RTSP] Stream dropped for ${worker.cameraId}: ${error.message}`);
    if (worker.retries > this.maxRetries) {
      worker.state = 'error';
      console.error(`[RTSP] Giving up on ${worker.cameraId} after ${this.maxRetries} retries`);
      return;
    }
    worker.state = 'reconnecting';
    const delay = Math.min(30000, 1000 * (2 ** (worker.retries - 1)));
    worker.retryTimer = setTimeout(() => this.#spawn(worker), delay);
  }

  /**
   * Test an RTSP URL connection and grab a single preview frame
   */
  static async testConnection(url, options = {}) {
    assertFfmpegAvailable();
    return new Promise((resolve) => {
      const transport = options.transport || 'tcp';
      const timeoutMs = options.timeoutMs || 8000;
      let resolved = false;
      let outputBuffer = Buffer.alloc(0);

      const isHttp = /^https?:\/\//i.test(url);
      const ffmpegArgs = ['-hide_banner', '-loglevel', 'error'];
      if (!isHttp) {
        ffmpegArgs.push('-rtsp_transport', transport);
        ffmpegArgs.push('-timeout', '5000000');
      }
      ffmpegArgs.push(
        '-i', url,
        '-vf', `scale='if(gt(iw,ih),min(640,iw),-2)':'if(gt(iw,ih),-2,min(640,ih))'`,
        '-vframes', '1',
        '-f', 'image2pipe',
        '-vcodec', 'mjpeg',
        '-q:v', '4',
        'pipe:1',
      );
      const child = spawn(ffmpegPath(), ffmpegArgs, { windowsHide: true });

      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          if (child) child.kill('SIGKILL');
          resolve({ success: false, error: 'Connection timed out after 8s' });
        }
      }, timeoutMs);

      child.stdout.on('data', chunk => {
        outputBuffer = Buffer.concat([outputBuffer, chunk]);
      });

      let lastError = '';
      child.stderr.on('data', chunk => {
        lastError += chunk.toString();
      });

      child.on('close', code => {
        clearTimeout(timer);
        if (resolved) return;
        resolved = true;
        if (code === 0 && outputBuffer.length > 100) {
          resolve({
            success: true,
            frameSize: outputBuffer.length,
            preview: `data:image/jpeg;base64,${outputBuffer.toString('base64')}`,
          });
        } else {
          resolve({
            success: false,
            error: lastError.trim() || `FFmpeg failed with exit code ${code}`,
          });
        }
      });

      child.on('error', err => {
        clearTimeout(timer);
        if (resolved) return;
        resolved = true;
        resolve({ success: false, error: err.message });
      });
    });
  }
}

module.exports = { RtspIngestion, assertFfmpegAvailable };