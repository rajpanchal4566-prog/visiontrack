const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { spawnFrameProcess } = require('./frameStream');
const { DEFAULTS } = require('./frameProcessor');
const { realtimeAnprPipeline } = require('./realtimeAnprPipeline');

class MediaEngine {
  constructor(options = {}) {
    this.jobs = new Map();
    this.workers = new Map();
    this.options = {
      ...DEFAULTS,
      rtspSampleFps: Number(process.env.RTSP_SAMPLE_FPS) > 0
        ? Number(process.env.RTSP_SAMPLE_FPS)
        : DEFAULTS.sampleFps,
      ...options,
    };
  }

  createVideoJob(input, options = {}) {
    const id = `video-${uuidv4()}`;
    const job = { id, input, source: 'video', state: 'created', frames: 0, detections: 0, vehicleFrames: 0, lastFrame: null, detectionResults: [], errors: [], createdAt: new Date().toISOString(), ...options };
    this.jobs.set(id, job);
    return job;
  }

  startVideoJob(id) {
    const job = this.jobs.get(id);
    if (!job || !['created', 'stopped', 'error'].includes(job.state)) return null;
    return this.#start(id, job.input, job, false);
  }

  stopVideoJob(id) { return this.#stop(this.jobs, id); }

  createRtspWorker(input, options = {}) {
    const id = options.id || `rtsp-${uuidv4()}`;
    if (this.workers.has(id)) return this.workers.get(id);
    const worker = { id, input, source: 'rtsp', state: 'created', reconnects: 0, frames: 0, vehicleFrames: 0, lastFrame: null, detectionResults: [], errors: [], createdAt: new Date().toISOString(), ...options };
    this.workers.set(id, worker);
    return worker;
  }

  startRtspWorker(id) {
    const worker = this.workers.get(id);
    if (!worker || !['created', 'stopped', 'error', 'reconnecting'].includes(worker.state)) return null;
    return this.#start(id, worker.input, worker, true);
  }

  stopRtspWorker(id) { return this.#stop(this.workers, id); }

  getJob(id) { return this.jobs.get(id) || this.workers.get(id) || null; }

  #start(id, input, record, reconnect) {
    record.state = 'starting';
    record.startedAt = new Date().toISOString();
    record.frameQueue = [];
    record.isProcessingQueue = false;
    record.streamFinished = false;
    record.hasFlushed = false;

    // Connect to the unified pipeline tracker instance
    record.tracker = realtimeAnprPipeline.getTracker(id);

    const sampleFps = record.sampleFps || (reconnect ? this.options.rtspSampleFps : this.options.sampleFps) || 16;
    const baseTimestamp = Date.now();

    const recordFinalizedTrack = async (finalizedTrack) => {
      if (!finalizedTrack.hasPlate || !finalizedTrack.bestReading) return;
      record.detections += 1;
      record.detectionResults.push({
        event_id: finalizedTrack.bestReading.detId,
        track_id: finalizedTrack.trackId,
        timestamp: finalizedTrack.bestReading.timestamp,
        plate: finalizedTrack.bestReading.plate,
        vehicle_type: finalizedTrack.vehicleType || 'unknown',
        confidence: finalizedTrack.bestReading.confidence || 0,
        image_path: finalizedTrack.bestReading.imagePath,
        ocr_text: finalizedTrack.bestReading.ocrText,
        ocr_confidence: finalizedTrack.bestReading.ocrConfidence,
        speed: finalizedTrack.speed ?? finalizedTrack.track?.estimatedSpeed ?? null,
        source_type: record.source || (reconnect ? 'rtsp' : 'video'),
      });
      if (record.detectionResults.length > 100) record.detectionResults.shift();

      if (typeof record.onTrackFinalized === 'function') {
        await record.onTrackFinalized(finalizedTrack, record);
      }
      if (typeof record.onDetection === 'function' && finalizedTrack.bestReading) {
        await record.onDetection(finalizedTrack.bestReading, null, { trackId: finalizedTrack.trackId });
      }
    };

    const flushFinalizedTracks = async () => {
      if (record.hasFlushed) return;
      record.hasFlushed = true;
      const flushed = await realtimeAnprPipeline.finalizeCamera(id, {
        cameraId: record.camera_id,
        sourceType: reconnect ? 'rtsp' : 'video',
      });
      if (flushed && flushed.length > 0) {
        for (const fin of flushed) {
          await recordFinalizedTrack(fin);
        }
      }
    };

    const processSingleFrame = async (frame) => {
      record.state = 'running';
      record.frames += 1;
      try {
        const frameTimestamp = new Date(baseTimestamp + Math.round((record.frames - 1) * (1000 / sampleFps))).toISOString();
        const processed = await realtimeAnprPipeline.processFrame(frame, {
          cameraId: record.camera_id,
          trackerKey: id,
          sourceType: reconnect ? 'rtsp' : 'video',
          timestamp: frameTimestamp,
          emitSocket: true,
        });

        record.lastFrame = processed.overlay || {
          timestamp: frameTimestamp,
          vehicle_detected: processed.vehicle_detected,
          vehicle_type: processed.vehicle_type || 'unknown',
          plate: processed.plate,
          violations: processed.violations || [],
          flagged: Boolean(processed.flagged),
          speed: processed.speed,
        };

        if (processed.vehicle_detected) record.vehicleFrames += 1;

        if (processed.finalizedTracks && processed.finalizedTracks.length > 0) {
          for (const fin of processed.finalizedTracks) {
            await recordFinalizedTrack(fin);
          }
        }
      } catch (error) {
        record.errors.push(error.message);
        if (record.errors.length > 20) record.errors.shift();
      }
    };

    const drainQueue = async () => {
      if (record.isProcessingQueue) return;
      record.isProcessingQueue = true;
      while (record.frameQueue && record.frameQueue.length > 0) {
        if (record.state === 'stopping' || record.state === 'stopped') break;
        const frame = record.frameQueue.shift();
        await processSingleFrame(frame);
      }
      record.isProcessingQueue = false;
      if (record.streamFinished && (!record.frameQueue || record.frameQueue.length === 0)) {
        await flushFinalizedTracks();
        if (record.state !== 'stopping') record.state = 'stopped';
      }
    };

    const child = spawnFrameProcess(input, {
      fps: sampleFps,
      ffmpegPath: this.options.ffmpegPath,
      onFrame: async frame => {
        if (record.state === 'stopping' || record.state === 'stopped') return;
        if (reconnect) {
          if (record.frameBusy) {
            record.droppedFrames = (record.droppedFrames || 0) + 1;
            return;
          }
          record.frameBusy = true;
          try {
            await processSingleFrame(frame);
          } finally {
            record.frameBusy = false;
          }
        } else {
          record.frameQueue.push(frame);
          drainQueue();
        }
      },
    });
    record.child = child;
    child.on('error', error => {
      record.errors.push(error.message);
      record.state = 'error';
    });
    child.on('close', async code => {
      record.child = null;
      record.streamFinished = true;
      if (record.state === 'stopping') {
        record.state = 'stopped';
      } else if (reconnect && record.state !== 'stopped') {
        record.state = 'reconnecting';
        record.reconnects += 1;
        const delay = Math.min(30000, 1000 * (2 ** Math.min(record.reconnects - 1, 5)));
        record.reconnectTimer = setTimeout(() => this.startRtspWorker(id), delay);
      } else if (!reconnect) {
        if (!record.isProcessingQueue && (!record.frameQueue || record.frameQueue.length === 0)) {
          await flushFinalizedTracks();
          record.state = code === 0 ? 'stopped' : 'error';
        }
      } else if (record.state !== 'error') {
        record.state = code === 0 ? 'stopped' : 'error';
      }
    });
    return record;
  }

  #stop(store, id) {
    const record = store.get(id);
    if (!record) return null;
    record.state = 'stopping';
    if (record.reconnectTimer) clearTimeout(record.reconnectTimer);
    realtimeAnprPipeline.finalizeCamera(id).catch(() => {});
    if (record.child) record.child.kill('SIGTERM');
    else record.state = 'stopped';
    return record;
  }
}

module.exports = { MediaEngine };
