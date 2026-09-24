// ============================================
// VisionTrack — Real-Time Smart ANPR Pipeline
// Unified frame-by-frame intelligence engine:
// 1. YOLO Vehicle & Occupant Detection (yolov8n.onnx)
// 2. Efficiency Gate: Skip OCR if no vehicle is in frame
// 3. YOLO License Plate Detection (license-plate-yolov8.onnx)
// 4. Smart OCR + Plate Normalization (PSM 7, sharp contrast, Indian RTO format)
// 5. Multi-Violation Detection (Helmet, Seatbelt, Overspeeding)
// 6. Spatial Multi-Frame Vehicle Tracking (VehicleTracker) & Best-Reading Selection
// 7. Live HUD WebSocket Streaming (stream:frame) & Persist Broadcast
// ============================================
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../database');
const { detectVehicles } = require('./vehicleDetector');
const { processPlateImage } = require('./ocrService');
const { detectViolations } = require('./violationDetector');
const { VehicleTracker, bboxIoU, CONFIRMATION_STATES, formatConfidencePercent } = require('./vehicleTracker');
const { scoreCropQuality } = require('./cropQualityScorer');
const { insertDetection } = require('./detectionPersistence');
const { updateTrafficStats, checkWatchlist } = require('../simulator/virtualCamera');
const { validateDetection } = require('./travelValidation');
const { detectPlate } = require('./plateDetector');
const { preparePlateCrop } = require('./plateCropPreprocessor');
const { recognizePlateNeuralEnhanced } = require('./indianPlatePostProcessor');
const { normalizePlateText, isIndianPlateFormat, isStandardPlateFormat } = require('./plateNormalizer');

const INDIA_MODEL_PATH = path.join(__dirname, '..', '..', 'models', 'license-plate-ocr-india-finetuned.onnx');

const UPLOADS_DIR = path.join(__dirname, '..', 'uploads', 'detections');
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

async function resizeFrameForYolo(frameBuffer, maxDim = 640) {
  try {
    const meta = await sharp(frameBuffer).metadata();
    if (!meta || !meta.width || !meta.height) return frameBuffer;
    if (meta.width <= maxDim && meta.height <= maxDim) return frameBuffer;

    const isWidthLonger = meta.width >= meta.height;
    return await sharp(frameBuffer)
      .resize({
        width: isWidthLonger ? maxDim : null,
        height: isWidthLonger ? null : maxDim,
        withoutEnlargement: true,
      })
      .jpeg({ quality: 85 })
      .toBuffer();
  } catch {
    return frameBuffer;
  }
}

class RealtimeAnprPipeline {
  constructor(options = {}) {
    this.trackers = new Map(); // cameraId -> VehicleTracker
    this.cameraFrameSeqs = new Map(); // trackerKey -> sequence number
    this.sampleFps = Number(options.sampleFps || Number(process.env.FRAME_SAMPLE_FPS || process.env.ANPR_SAMPLE_FPS || 16));
    this.maxMissedTimeSec = Number(options.maxMissedTimeSec ?? 1.8);
    this.maxMissedFrames = Number(options.maxMissedFrames ?? Math.max(15, Math.round(this.sampleFps * this.maxMissedTimeSec)));
    this.iouThreshold = Number(options.iouThreshold ?? 0.20);
    this.deferOcr = Boolean(options.deferOcr); // Deferred OCR mode: score frames cheaply, OCR at finalization
  }

  /**
   * Get or instantiate the VehicleTracker for a specific camera stream
   */
  getTracker(cameraId = 'default', sampleFps = null) {
    const fps = sampleFps ? Number(sampleFps) : this.sampleFps;
    if (!this.trackers.has(cameraId)) {
      this.trackers.set(cameraId, new VehicleTracker({
        sampleFps: fps,
        maxMissedTimeSec: this.maxMissedTimeSec,
        maxMissedFrames: Math.max(15, Math.round(fps * this.maxMissedTimeSec)),
        iouThreshold: this.iouThreshold,
        maxCentroidDistanceRatio: 0.75,
        uploadsDir: UPLOADS_DIR,
        deferOcr: this.deferOcr,
        ocrFunction: processPlateImage,
      }));
    } else if (sampleFps) {
      this.trackers.get(cameraId).setFps(fps);
    }
    return this.trackers.get(cameraId);
  }

  /**
   * Finalize all active tracks for a camera or stream (e.g. on stream stop or disconnect)
   */
  async finalizeCamera(trackerKey, context = {}) {
    this.cameraFrameSeqs.delete(trackerKey);
    if (this.trackers.has(trackerKey)) {
      const tracker = this.trackers.get(trackerKey);
      const finalized = await tracker.finalizeAll();
      this.trackers.delete(trackerKey);

      const db = getDb();
      let camera = context.camera || null;
      if (typeof camera === 'string') {
        camera = db.prepare('SELECT * FROM cameras WHERE id = ?').get(camera);
      }
      const cameraId = camera?.id || context.cameraId || trackerKey;
      const sourceType = context.sourceType || 'rtsp';

      for (const fin of finalized) {
        if (fin.hasPlate && fin.bestReading) {
          await this.#persistDetectionRecord({
            camera,
            cameraId,
            plate: fin.bestReading.plate,
            confidence: fin.bestReading.confidence,
            vehicleType: fin.vehicleType,
            vehicleBbox: fin.track?.bbox,
            speed: fin.speed ?? fin.track?.estimatedSpeed ?? null,
            ocrResult: fin.bestReading,
            violationResult: fin.violationResult || { violations: [], flagged: false },
            sourceType,
            frameBuffer: fin.bestReading.frameBuffer,
            trackId: fin.trackId,
            framesTracked: fin.framesTracked,
          });
        }
      }
      return finalized;
    }
    return [];
  }

  /**
   * Process a single video / stream frame
   *
   * @param {Buffer} frameBuffer - JPEG image buffer
   * @param {object} context
   *   - camera: object (or cameraId)
   *   - sourceType: 'rtsp' | 'video' | 'camera_anpr'
   *   - emitSocket: boolean (default true)
   *   - telemetry: extra sensor data (optional)
   * @returns {Promise<object>} Processing summary & overlay data
   */
  async processFrame(frameBuffer, context = {}) {
    const startedAt = Date.now();
    const timings = {};

    if (!Buffer.isBuffer(frameBuffer) || frameBuffer.length === 0) {
      return { success: false, reason: 'INVALID_FRAME_BUFFER' };
    }

    const db = getDb();
    let camera = context.camera || null;
    if (typeof camera === 'string') {
      camera = db.prepare('SELECT * FROM cameras WHERE id = ?').get(camera);
    }
    const cameraId = camera?.id || context.cameraId || 'CAM-STREAM';
    const trackerKey = context.trackerKey || cameraId;

    // Maintain independent per-camera frame sequence for isolated tracking cadence
    const frameSeq = (this.cameraFrameSeqs.get(trackerKey) || 0) + 1;
    this.cameraFrameSeqs.set(trackerKey, frameSeq);

    // Stage 1: Frame Pre-Check & Dual-Scale Setup
    const tResize0 = Date.now();
    let origMeta = null;
    try {
      origMeta = await sharp(frameBuffer).metadata();
    } catch {
      origMeta = { width: 640, height: 480 };
    }
    const activeFrame = await resizeFrameForYolo(frameBuffer, 640);
    const activeMeta = (origMeta.width <= 640 && origMeta.height <= 640)
      ? origMeta
      : await sharp(activeFrame).metadata();
    timings.resizeMs = Date.now() - tResize0;

    const scaleX = (origMeta?.width && activeMeta?.width) ? origMeta.width / activeMeta.width : 1;
    const scaleY = (origMeta?.height && activeMeta?.height) ? origMeta.height / activeMeta.height : 1;
    const sourceType = context.sourceType || 'rtsp';
    const emitSocket = context.emitSocket !== false;
    const sampleFps = Number(context.sampleFps || Number(process.env.FRAME_SAMPLE_FPS || process.env.ANPR_SAMPLE_FPS || process.env.VIDEO_SAMPLE_FPS) || 16);
    const tracker = this.getTracker(trackerKey, sampleFps);
    const timestamp = context.timestamp || new Date().toISOString();

    // High-FPS Interleaved Tracking Cadence
    // When operating at high FPS, if all active tracks are confirmed AND stable, interleaved frames
    // propagate using linear velocity prediction (<1ms), sustaining high real-time throughput.
    //
    // IMPORTANT: Only activate interleaved mode for a SINGLE confirmed track (size === 1).
    // Multi-vehicle scenes must always run full detection to correctly associate plates to their
    // respective vehicles. Also require framesTracked >= 5 to avoid locking in early wrong reads.
    const allActiveConfirmed = tracker.activeTracks.size > 0
      && [...tracker.activeTracks.values()].every(t =>
        (t.confirmedPlate || t.shouldSkipOcr) && t.framesTracked >= 5
      );
    const stride = sampleFps >= 14 ? 3 : (sampleFps >= 9 ? 4 : (sampleFps >= 7 ? 3 : 2));
    // FIX (Bug 3): Restrict interleaved mode to single-track scenarios only.
    // With multiple tracks, plates can be assigned to wrong vehicles via activeTracks[0] shortcut.
    const isInterleaved = sampleFps >= 7
      && (frameSeq % stride !== 0)
      && allActiveConfirmed
      && tracker.activeTracks.size === 1;

    if (isInterleaved) {
      tracker.propagateInterleaved({ frameIndex: frameSeq, timestamp });
      const activeTracks = [...tracker.activeTracks.values()];
      const elapsedMs = Date.now() - startedAt;

      // FIX (Bug 1): Build per-track vehicle overlay instead of picking activeTracks[0] as primary.
      // Each vehicle carries its OWN confirmed plate — prevents plate A showing on vehicle B.
      const interleavedVehicles = activeTracks.map(t => {
        const bestR = t.getBestReading();
        return {
          vehicle_type: t.vehicleType,
          vehicle_confidence: 0.85,
          vehicle_bbox: t.bbox,
          track_id: t.id,
          trackId: t.id,
          confirmation_state: t.confirmationState,
          confirmationState: t.confirmationState,
          confirmed_plate: t.confirmedPlate || null,
          confirmedPlate: t.confirmedPlate || null,
          current_plate: bestR?.plate || t.confirmedPlate || null,
          currentPlate: bestR?.plate || t.confirmedPlate || null,
          plate_confidence: t.lastEvaluation?.confidence || 0.85,
          plateBbox: bestR?.plateRegion || null,
          framesTracked: t.framesTracked,
          readingsCount: t.ocrReadings.length,
        };
      });

      // For the global overlay.plate field (legacy/single-vehicle HUD compat):
      // Use the single track's plate since we guarantee size === 1 here.
      const singleTrack = activeTracks[0] || null;
      const singlePlate = singleTrack?.confirmedPlate || singleTrack?.getBestReading()?.plate || null;

      const overlay = {
        cameraId,
        sourceType,
        timestamp,
        frameWidth: 640,
        frameHeight: 480,
        vehicleDetected: activeTracks.length > 0,
        vehicles: interleavedVehicles,
        occupants: [],
        plate: singlePlate ? {
          plate: singlePlate,
          confidence: singleTrack.lastEvaluation?.confidence || 0.95,
          ocrText: singleTrack.getBestReading()?.rawPlate || singlePlate,
          bbox: singleTrack.bbox,
        } : null,
        violations: singleTrack?.cachedViolations || [],
        flagged: Boolean(singleTrack?.cachedViolations?.length > 0),
        speed: singleTrack?.estimatedSpeed ?? null,
        speedLimit: Number(camera?.speed_limit_kmh) || 50,
        processingTimeMs: elapsedMs,
      };

      if (emitSocket && global.io) {
        this.#emitFrame(camera, overlay, activeFrame);
      }

      return {
        success: true,
        vehicle_detected: activeTracks.length > 0,
        vehicle_type: singleTrack?.vehicleType || 'unknown',
        plate: singlePlate,
        speed: singleTrack?.estimatedSpeed ?? null,
        violations: singleTrack?.cachedViolations || [],
        flagged: Boolean(singleTrack?.cachedViolations?.length > 0),
        processing_time_ms: elapsedMs,
        overlay,
        finalizedTracks: [],
      };
    }

    // Stage 2: Fast Vehicle & Occupant Detection (YOLOv8n)
    const tVeh0 = Date.now();
    const vehicleResult = await detectVehicles(activeFrame, {
      includeOccupants: true,
      confidenceThreshold: 0.20,
    });
    timings.vehicleDetMs = Date.now() - tVeh0;

    const hasVehicle = vehicleResult.vehicle_detected;
    let detectedVehicleType = vehicleResult.detected_vehicle_type || 'unknown';
    const vehicleBbox = vehicleResult.vehicle_bbox || null;
    const occupants = vehicleResult.occupants || [];

    // Frame HUD Overlay Base
    const overlay = {
      cameraId,
      sourceType,
      timestamp,
      frameWidth: vehicleResult.image?.width || 640,
      frameHeight: vehicleResult.image?.height || 480,
      vehicleDetected: hasVehicle,
      vehicles: [],
      occupants,
      plate: null,
      violations: [],
      flagged: false,
      speed: null,
      speedLimit: Number(camera?.speed_limit_kmh) || 50,
      processingTimeMs: 0,
    };

    // EFFICIENCY GATE: If NO vehicle in frame, update tracker with [] so missed frame counters
    // increment and vehicles that departed can finalize properly!
    if (!hasVehicle) {
      const tTrack0 = Date.now();
      const trackingUpdate = await tracker.update([], {
        frameIndex: frameSeq,
        timestamp: overlay.timestamp,
        frameBuffer: activeFrame,
      });
      timings.trackingMs = Date.now() - tTrack0;

      // Finalize any tracks that completed when the vehicle left
      const finalizedDetections = [];
      for (const fin of trackingUpdate.finalized) {
        if (fin.hasPlate && fin.bestReading) {
          const tPersist0 = Date.now();
          const persisted = await this.#persistDetectionRecord({
            camera,
            cameraId,
            plate: fin.bestReading.plate,
            confidence: fin.bestReading.confidence,
            vehicleType: fin.vehicleType,
            vehicleBbox: fin.track?.bbox,
            speed: fin.speed ?? fin.track?.estimatedSpeed ?? null,
            ocrResult: fin.bestReading,
            violationResult: { violations: [], flagged: false },
            sourceType,
            frameBuffer: fin.bestReading.frameBuffer || activeFrame,
            trackId: fin.trackId,
            framesTracked: fin.framesTracked,
          });
          timings.persistAndBroadcastMs = Date.now() - tPersist0;
          if (persisted) finalizedDetections.push(persisted);
        }
      }

      overlay.processingTimeMs = Date.now() - startedAt;
      if (emitSocket && global.io) {
        this.#emitFrame(camera, overlay, activeFrame);
      }

      // Diagnostic Logging for idle / departed frame
      this.#logFrameDiagnostics({
        frameSeq,
        timestamp: overlay.timestamp,
        cameraId,
        hasVehicle: false,
        detectedVehicleType: 'none',
        vehicleBbox: null,
        hasPlate: false,
        plateConfidence: null,
        plateBbox: null,
        rawOcrText: null,
        ocrConfidence: null,
        gateResult: { passed: false, reason: 'No vehicle in frame (OCR skipped)' },
        trackingAction: trackingUpdate.finalized.length > 0 ? 'FINALIZING_TRACKS' : 'MISSED_FRAME',
        trackingDetails: `Active tracks: ${trackingUpdate.activeTracks.length}, Finalized: ${trackingUpdate.finalized.length}`,
        finalizedDetections,
        timings,
        totalLatencyMs: overlay.processingTimeMs,
      });

      return {
        success: true,
        vehicle_detected: false,
        processing_time_ms: overlay.processingTimeMs,
        detection: finalizedDetections[0] || null,
        overlay,
      };
    }

    // Stage 3 & 4: Multi-Vehicle License Plate Detection + Smart OCR
    const tPlate0 = Date.now();
    const activeTracker = tracker;
    const meta = vehicleResult.image || { width: 640, height: 480 };
    const rawVehicles = (vehicleResult.vehicle_detections && vehicleResult.vehicle_detections.length > 0)
      ? vehicleResult.vehicle_detections
      : (vehicleBbox ? [{ vehicle_type: detectedVehicleType, vehicle_bbox: vehicleBbox }] : []);

    let plateDet = null;
    try {
      plateDet = await detectPlate(activeFrame);
    } catch (err) {
      console.warn(`[SmartANPR] Plate detector error: ${err.message}`);
    }

    const detectedPlates = plateDet?.success ? (plateDet.detections || []) : [];

    // Associate each detected plate with its enclosing vehicle
    // FIX (Bug 4): Use 10% tolerance buffer so slightly-clipped plates at 640px scale
    // still match the correct vehicle. Fallback uses nearest vehicle centroid (not IoU >= 0.05
    // which was too loose and could match wrong adjacent vehicle).
    const vehiclePlateMap = new Map(); // vehicleIndex -> plateDetObj

    for (const pb of detectedPlates) {
      const pcx = pb.x + pb.width / 2;
      const pcy = pb.y + pb.height / 2;
      let bestVIdx = -1;
      let bestScore = -Infinity;

      for (let vIdx = 0; vIdx < rawVehicles.length; vIdx++) {
        const vb = rawVehicles[vIdx].vehicle_bbox || rawVehicles[vIdx].bbox;
        if (!vb) continue;

        // 10% tolerance on plate dimensions to handle slightly-clipped plate centroids
        const tolX = Math.max(5, pb.width * 0.10);
        const tolY = Math.max(5, pb.height * 0.10);
        const isInside = (
          pcx >= vb.x - tolX && pcx <= vb.x + vb.width + tolX &&
          pcy >= vb.y - tolY && pcy <= vb.y + vb.height + tolY
        );
        if (isInside) {
          const area = vb.width * vb.height;
          const score = 10000 - Math.min(area, 9000) + pb.confidence * 1000;
          if (score > bestScore) {
            bestScore = score;
            bestVIdx = vIdx;
          }
        }
      }

      // FIX (Bug 4): Fallback — nearest vehicle centroid within reasonable distance.
      // Replaces old IoU >= 0.05 which could match plates to wrong adjacent vehicles.
      if (bestVIdx === -1) {
        let minDist = Infinity;
        for (let vIdx = 0; vIdx < rawVehicles.length; vIdx++) {
          const vb = rawVehicles[vIdx].vehicle_bbox || rawVehicles[vIdx].bbox;
          if (!vb) continue;
          const vcx = vb.x + vb.width / 2;
          const vcy = vb.y + vb.height / 2;
          const dist = Math.hypot(pcx - vcx, pcy - vcy);
          // Only accept if plate centroid is within 80% of the vehicle diagonal
          const maxAcceptableDist = Math.hypot(vb.width, vb.height) * 0.8;
          if (dist < minDist && dist < maxAcceptableDist) {
            minDist = dist;
            bestVIdx = vIdx;
          }
        }
      }

      if (bestVIdx !== -1) {
        const existing = vehiclePlateMap.get(bestVIdx);
        if (!existing || pb.confidence > existing.confidence) {
          vehiclePlateMap.set(bestVIdx, pb);
        }
      }
    }

    // Now, for EACH vehicle, run OCR or retrieve confirmed plate
    const vehicleReadings = new Map(); // vehicleIndex -> ocrResult
    let primaryOcrResult = null;
    let primaryPlate = null;

    for (let vIdx = 0; vIdx < rawVehicles.length; vIdx++) {
      const rv = rawVehicles[vIdx];
      const vb = rv.vehicle_bbox || rv.bbox;
      const pb = vehiclePlateMap.get(vIdx) || null;

      // Check if this vehicle already belongs to a confirmed track
      const existingMatch = vb ? activeTracker.findBestMatch(vb) : null;
      if (existingMatch && existingMatch.shouldSkipOcr && existingMatch.confirmedPlate) {
        const best = existingMatch.getBestReading();
        const reading = {
          plate: existingMatch.confirmedPlate,
          rawPlate: best?.rawPlate || existingMatch.confirmedPlate,
          rawText: best?.rawPlate || existingMatch.confirmedPlate,
          confidence: existingMatch.lastEvaluation?.confidence || 0.95,
          ocrConfidence: (existingMatch.lastEvaluation?.topCandidate?.avgOcrConf || 0.95) * 100,
          detectorConfidence: (existingMatch?.lastEvaluation?.topCandidate?.avgDetConf || 0.85) * 100,
          plateRegion: pb || existingMatch.bbox,
          skippedOcr: true,
        };
        vehicleReadings.set(vIdx, reading);
        if (!primaryOcrResult || reading.confidence > (primaryOcrResult.confidence || 0)) {
          primaryOcrResult = reading;
          primaryPlate = reading.plate;
        }
        continue;
      }

      // If vehicle has a detected plate, run Model 3 neural OCR with dual-scale high-res crop
      if (pb) {
        try {
          const highResPb = (scaleX !== 1 || scaleY !== 1) ? {
            x: Math.round(pb.x * scaleX),
            y: Math.round(pb.y * scaleY),
            width: Math.round(pb.width * scaleX),
            height: Math.round(pb.height * scaleY),
            confidence: pb.confidence,
          } : pb;

          const prep = await preparePlateCrop(frameBuffer, highResPb, origMeta);
          if (prep && prep.ocrCrop) {
            const enhancedResult = await recognizePlateNeuralEnhanced(prep.ocrCrop, INDIA_MODEL_PATH);
            if (enhancedResult && (enhancedResult.plate || enhancedResult.rawText)) {
              const rawText = enhancedResult.rawText || enhancedResult.plate || '';
              const norm = normalizePlateText(enhancedResult.plate || rawText);
              const conf = enhancedResult.confidencePercent || (enhancedResult.confidence * 100) || 0;
              const hasValidFormat = norm.plate && (isIndianPlateFormat(norm.plate) || isStandardPlateFormat(norm.plate));
              const effectivePlate = norm.plate || (conf >= 25 ? rawText.toUpperCase().replace(/[^A-Z0-9]/g, '') : null);

              if (effectivePlate && (hasValidFormat || conf >= 25)) {
                const reading = {
                  plate: effectivePlate,
                  rawPlate: rawText,
                  rawText,
                  confidence: conf / 100,
                  ocrConfidence: conf,
                  detectorConfidence: pb.confidence * 100,
                  plateRegion: pb,
                  frameBuffer: prep.ocrCrop,
                  skippedOcr: false,
                };
                vehicleReadings.set(vIdx, reading);

                if (existingMatch && typeof existingMatch.recordOcrAttempt === 'function') {
                  existingMatch.recordOcrAttempt(reading);
                }

                if (!primaryOcrResult || reading.confidence > (primaryOcrResult.confidence || 0)) {
                  primaryOcrResult = reading;
                  primaryPlate = effectivePlate;
                }
              }
            }
          }
        } catch (err) {
          console.warn(`[SmartANPR] Vehicle ${vIdx} OCR error: ${err.message}`);
        }
      }
    }

    // Fallback: If no vehicle plate was detected by multi-vehicle logic, run processPlateImage on high-res frameBuffer
    if (!primaryPlate && detectedPlates.length === 0 && rawVehicles.length <= 1) {
      try {
        const fallbackRes = await processPlateImage(frameBuffer);
        if (fallbackRes?.plate) {
          const rawConf = Number(fallbackRes.finalConfidence || fallbackRes.confidence || 0);
          const normConf = rawConf > 1 ? rawConf / 100 : rawConf;
          if (normConf >= 0.25) {
            primaryPlate = fallbackRes.plate;
            primaryOcrResult = fallbackRes;
            vehicleReadings.set(0, fallbackRes);
          }
        }
      } catch (err) {
        console.warn(`[SmartANPR] Fallback plate OCR error: ${err.message}`);
      }
    }

    timings.plateOcrMs = Date.now() - tPlate0;

    // Set overlay plate to the primary detected plate
    if (primaryPlate && primaryOcrResult) {
      overlay.plate = {
        plate: primaryPlate,
        confidence: primaryOcrResult.confidence > 1 ? primaryOcrResult.confidence / 100 : primaryOcrResult.confidence,
        ocrText: primaryOcrResult.rawText || primaryPlate,
        bbox: primaryOcrResult.plateRegion || primaryOcrResult.plate_bbox || null,
      };
    }

    // Stage 5: Multi-Violation Detection (Helmet, Seatbelt, Speeding)
    const tViol0 = Date.now();
    const existingTrackMatch = vehicleBbox ? activeTracker.findBestMatch(vehicleBbox) : null;
    const violationResult = await detectViolations({
      imageBuffer: activeFrame,
      vehicle: {
        detected_vehicle_type: detectedVehicleType,
        vehicle_bbox: vehicleBbox,
        vehicle_confidence: vehicleResult.vehicle_confidence || 0,
      },
      occupants,
      plate: primaryPlate,
      trackId: existingTrackMatch?.id,
      track: existingTrackMatch,
      timestamp,
      speed: context.telemetry?.speed,
      camera: camera || { speed_limit_kmh: 50 },
      telemetry: context.telemetry || {},
    });
    timings.violationMs = Date.now() - tViol0;

    overlay.violations = violationResult.violations || [];
    overlay.flagged = violationResult.flagged || false;
    overlay.speed = violationResult.speed;

    // Stage 6: Multi-Frame Vehicle Tracking & Multi-Plate Association (VehicleTracker)
    const tTrack0 = Date.now();
    const vehicleDetections = [];

    if (rawVehicles.length > 0) {
      for (let i = 0; i < rawVehicles.length; i++) {
        const rv = rawVehicles[i];
        const vBbox = rv.vehicle_bbox || rv.bbox;
        if (!vBbox) continue;
        const reading = vehicleReadings.get(i) || null;

        vehicleDetections.push({
          bbox: vBbox,
          vehicleType: rv.vehicle_type || rv.type || detectedVehicleType || 'vehicle',
          confidence: rv.vehicle_confidence ?? rv.confidence ?? 0.8,
          plate: reading?.plate || null,
          rawPlate: reading?.rawPlate || reading?.plate || null,
          ocrText: reading?.rawText || reading?.plate || null,
          ocrConfidence: reading?.ocrConfidence ?? (reading?.confidence ? reading.confidence * 100 : null),
          plateConfidence: reading?.detectorConfidence || null,
          speed: violationResult.speed,
          plateRegion: reading?.plateRegion || null,
          frameBuffer: reading?.frameBuffer || null,
        });
      }
    } else if (primaryBbox) {
      const reading = vehicleReadings.get(0) || primaryOcrResult;
      vehicleDetections.push({
        bbox: primaryBbox,
        vehicleType: detectedVehicleType || 'vehicle',
        confidence: vehicleResult.vehicle_confidence || 0.8,
        plate: reading?.plate || null,
        rawPlate: reading?.rawPlate || reading?.plate || null,
        ocrText: reading?.rawText || reading?.plate || null,
        ocrConfidence: reading?.ocrConfidence ?? (reading?.confidence ? reading.confidence * 100 : null),
        plateConfidence: reading?.detectorConfidence || null,
        speed: violationResult.speed,
        plateRegion: reading?.plateRegion || null,
        frameBuffer: reading?.frameBuffer || null,
      });
    }

    const trackingUpdate = await tracker.update(vehicleDetections, {
      frameIndex: frameSeq,
      timestamp: overlay.timestamp,
      frameBuffer: activeFrame,
    });
    timings.trackingMs = Date.now() - tTrack0;

    // FIX (Bug 5): Map active tracks to Live HUD Overlay WITH per-track plate identity.
    // Each vehicle carries its OWN confirmedPlate, confirmationState, and plateBbox so
    // the dashboard can label each vehicle box independently (prevents plate A on vehicle B).
    const mappedVehicles = (trackingUpdate.activeTracks || []).map(t => {
      const lastReading = t.ocrReadings[t.ocrReadings.length - 1] || null;
      return {
        trackId: t.id,
        type: t.vehicleType,
        confidence: 0.9,
        bbox: t.bbox,
        framesTracked: t.framesTracked,
        readingsCount: t.ocrReadings.length,
        // Per-track plate data — prevents cross-vehicle plate assignment in HUD
        confirmedPlate: t.confirmedPlate || null,
        currentPlate: lastReading?.plate || t.confirmedPlate || null,
        confirmationState: t.confirmationState,
        plateBbox: lastReading?.plateRegion || null,
        plateConfidence: t.lastEvaluation?.confidence || null,
      };
    });
    overlay.vehicles = mappedVehicles.length > 0 ? mappedVehicles : (vehicleResult.vehicle_detections || []);

    // Stage 7: Persist & Broadcast Finalized Vehicles
    const finalizedDetections = [];
    for (const finalized of trackingUpdate.finalized) {
      if (finalized.hasPlate && finalized.bestReading) {
        const tPersist0 = Date.now();
        const persisted = await this.#persistDetectionRecord({
          camera,
          cameraId,
          plate: finalized.bestReading.plate,
          confidence: finalized.bestReading.confidence,
          vehicleType: finalized.vehicleType,
          vehicleBbox: finalized.track?.bbox,
          speed: finalized.speed ?? finalized.track?.estimatedSpeed ?? violationResult.speed ?? null,
          ocrResult: finalized.bestReading,
          violationResult,
          sourceType,
          frameBuffer: finalized.bestReading.frameBuffer || activeFrame,
          trackId: finalized.trackId,
          framesTracked: finalized.framesTracked,
        });
        timings.persistAndBroadcastMs = Date.now() - tPersist0;
        if (persisted) finalizedDetections.push(persisted);
      }
    }

    overlay.processingTimeMs = Date.now() - startedAt;

    // Broadcast live HUD frame overlay to connected dashboard monitors
    if (emitSocket && global.io) {
      this.#emitFrame(camera, overlay, activeFrame);
    }

    // Determine tracking action description for diagnostic log
    let trackingAction = 'ACTIVE_TRACKING';
    let trackingDetails = `Active tracks: ${trackingUpdate.activeTracks.length}`;
    if (trackingUpdate.finalized.length > 0) {
      trackingAction = 'TRACK_FINALIZED';
      trackingDetails = `Finalized ${trackingUpdate.finalized.length} track(s): ${trackingUpdate.finalized.map(f => `${f.trackId} (plate: ${f.bestReading?.plate || 'none'})`).join(', ')}`;
    } else if (trackingUpdate.activeTracks.length > 0) {
      const activeIds = trackingUpdate.activeTracks.map(t => `${t.id} [${t.confirmationState}] (${t.framesTracked}f, ${t.observations?.length || 0}obs${t.confirmedPlate ? `, plate: ${t.confirmedPlate}` : ''})`).join(', ');
      trackingDetails = `Tracking: ${activeIds}`;
    }

    // Diagnostic Per-Frame Logging
    this.#logFrameDiagnostics({
      frameSeq,
      timestamp: overlay.timestamp,
      cameraId,
      hasVehicle: true,
      detectedVehicleType,
      vehicleBbox,
      hasPlate: Boolean(primaryPlate),
      plateConfidence: primaryOcrResult?.detectorConfidence,
      plateBbox: primaryOcrResult?.plateRegion || primaryOcrResult?.plate_bbox,
      rawOcrText: primaryOcrResult?.rawText,
      ocrConfidence: primaryOcrResult?.ocrConfidence ?? primaryOcrResult?.confidence,
      gateResult: { passed: Boolean(primaryPlate), plate: primaryPlate, conf: primaryOcrResult?.confidence },
      trackingAction,
      trackingDetails,
      finalizedDetections,
      timings,
      totalLatencyMs: overlay.processingTimeMs,
    });

    return {
      success: true,
      vehicle_detected: true,
      vehicle_type: detectedVehicleType,
      plate: primaryPlate,
      violations: violationResult.violations,
      flagged: violationResult.flagged,
      speed: violationResult.speed,
      processing_time_ms: overlay.processingTimeMs,
      detection: finalizedDetections[0] || null,
      activeTracks: trackingUpdate.activeTracks,
      overlay,
      finalizedTracks: trackingUpdate.finalized,
    };
  }

  /**
   * Diagnostic per-frame logging with real timestamps and stage latency breakdown
   */
  #logFrameDiagnostics(info) {
    if (process.env.DEBUG_ANPR !== 'true' && process.env.DEBUG !== 'true' && process.env.DEBUG !== '1') {
      return;
    }
    const {
      frameSeq,
      timestamp,
      cameraId,
      hasVehicle,
      detectedVehicleType,
      vehicleBbox,
      hasPlate,
      plateConfidence,
      plateBbox,
      rawOcrText,
      ocrConfidence,
      gateResult,
      trackingAction,
      trackingDetails,
      finalizedDetections = [],
      timings = {},
      totalLatencyMs,
    } = info;

    const timeStr = timestamp || new Date().toISOString();
    console.log(`\n[ANPR-LIVE-DIAG] ── Frame #${frameSeq} @ ${timeStr} ── Camera: ${cameraId}`);

    // 1. Vehicle Detection
    if (hasVehicle) {
      const bStr = vehicleBbox ? `[x:${Math.round(vehicleBbox.x)}, y:${Math.round(vehicleBbox.y)}, w:${Math.round(vehicleBbox.width)}, h:${Math.round(vehicleBbox.height)}]` : 'N/A';
      console.log(`  ├─ 1. Vehicle Detected: YES | type=${detectedVehicleType.toUpperCase()} | bbox=${bStr} | took ${timings.vehicleDetMs || 0}ms`);
    } else {
      console.log(`  ├─ 1. Vehicle Detected: NO (efficiency gate triggered: OCR skipped) | took ${timings.vehicleDetMs || 0}ms`);
    }

    // 2. Plate Detection
    if (hasPlate) {
      const pbStr = plateBbox ? `[x:${Math.round(plateBbox.x)}, y:${Math.round(plateBbox.y)}, w:${Math.round(plateBbox.width)}, h:${Math.round(plateBbox.height)}]` : 'N/A';
      console.log(`  ├─ 2. Plate Detected:   YES | conf=${formatConfidencePercent(plateConfidence)} | bbox=${pbStr}`);
    } else {
      console.log(`  ├─ 2. Plate Detected:   NO ${hasVehicle ? '(no plate bbox located)' : '(skipped)'}`);
    }

    // 3. OCR Reading
    if (rawOcrText) {
      console.log(`  ├─ 3. OCR Reading:      raw="${rawOcrText}" | conf=${formatConfidencePercent(ocrConfidence)} | took ${timings.plateOcrMs || 0}ms`);
    } else {
      console.log(`  ├─ 3. OCR Reading:      NONE ${hasVehicle ? '(no text extracted)' : '(skipped)'}`);
    }

    // 4. Confidence Gate
    if (gateResult.passed) {
      console.log(`  ├─ 4. Confidence Gate:  PASSED | plate="${gateResult.plate}" (conf: ${formatConfidencePercent(gateResult.conf)}, reason: ${gateResult.reason})`);
    } else {
      console.log(`  ├─ 4. Confidence Gate:  REJECTED | reason: ${gateResult.reason}`);
    }

    // 5. Tracking / Dedup
    console.log(`  ├─ 5. Tracker / Dedup:  ${trackingAction} | ${trackingDetails || 'N/A'} | took ${timings.trackingMs || 0}ms`);

    // 6. Latency Breakdown
    const timingParts = [];
    if (timings.resizeMs !== undefined) timingParts.push(`Resize: ${timings.resizeMs}ms`);
    if (timings.vehicleDetMs !== undefined) timingParts.push(`VehDet: ${timings.vehicleDetMs}ms`);
    if (timings.plateOcrMs !== undefined) timingParts.push(`PlateOCR: ${timings.plateOcrMs}ms`);
    if (timings.violationMs !== undefined) timingParts.push(`Viol: ${timings.violationMs}ms`);
    if (timings.trackingMs !== undefined) timingParts.push(`Track: ${timings.trackingMs}ms`);
    if (timings.persistAndBroadcastMs !== undefined) timingParts.push(`Persist&Bcast: ${timings.persistAndBroadcastMs}ms`);
    timingParts.push(`Total: ${totalLatencyMs}ms`);
    console.log(`  ├─ 6. Latency Timings:  ${timingParts.join(' | ')}`);

    // 7. Final Outcome
    if (finalizedDetections.length > 0) {
      for (const fin of finalizedDetections) {
        console.log(`  └─ 7. Final Outcome:    PERSISTED & BROADCAST [Track ${fin.trackId || 'N/A'} -> Plate: ${fin.plate} (${fin.vehicle_type}), Det ID: ${fin.id}]`);
      }
    } else if (hasVehicle) {
      console.log(`  └─ 7. Final Outcome:    TRACKING_IN_PROGRESS (HUD overlay broadcasted, waiting for vehicle to complete pass)`);
    } else {
      console.log(`  └─ 7. Final Outcome:    DISCARDED (no vehicle / idle frame)`);
    }
  }

  /**
   * Persist verified detection into database and notify clients
   */
  async #persistDetectionRecord(data) {
    try {
      const detId = data.ocrResult?.detId || `DET-${uuidv4().slice(0, 8).toUpperCase()}`;
      const eventId = `${data.sourceType}-${uuidv4()}`;
      const timestamp = data.ocrResult?.timestamp || new Date().toISOString();

      // Save evidence frame snapshot if not already saved by tracker
      let imagePath = data.ocrResult?.imagePath || null;
      if (!imagePath && data.frameBuffer) {
        const fileName = `snap_${detId}_${Date.now()}.jpg`;
        const filePath = path.join(UPLOADS_DIR, fileName);
        await fs.promises.writeFile(filePath, data.frameBuffer);
        imagePath = `/uploads/detections/${fileName}`;
      }

      const violationLabels = (data.violationResult?.violations || []).map(v => v.label || v);
      const flagged = (data.violationResult?.flagged || false) ? 1 : 0;
      const violationType = violationLabels.join(', ') || null;

      const detection = {
        id: detId,
        event_id: eventId,
        plate: data.plate,
        camera_id: data.camera?.id || data.cameraId,
        location_id: data.camera?.zone || 'Zone-1',
        timestamp,
        confidence: data.confidence > 1 ? data.confidence / 100 : data.confidence,
        vehicle_type: data.vehicleType || 'unknown',
        vehicle_color: null,
        speed: data.speed ?? null,
        direction: null,
        image_path: imagePath,
        violations: JSON.stringify(violationLabels),
        flagged,
        violation_type: violationType,
        flag_source: flagged ? 'smart_anpr_pipeline' : null,
        investigation_status: flagged ? 'analyzed' : 'clear',
        investigation_confidence: flagged ? 0.95 : 0,
        investigation_details: JSON.stringify({
          trackId: data.trackId,
          framesTracked: data.framesTracked,
          speedEstimate: data.speed !== null && data.speed !== undefined ? `${data.speed} km/h (estimated)` : null,
          violationResult: data.violationResult || {},
          vehicleBbox: data.vehicleBbox,
        }),
        ocr_text: data.ocrResult?.rawText || data.ocrResult?.ocrText || data.plate,
        ocr_confidence: data.ocrResult?.ocrConfidence ?? data.confidence,
        ocr_status: 'success',
        source_type: data.sourceType || 'rtsp',
      };

      const inserted = insertDetection(detection);
      if (inserted && !inserted.duplicate) {
        if (data.camera?.id) {
          updateTrafficStats(data.camera.id, detection.vehicle_type);
        }

        const detectionEvent = {
          ...detection,
          trackId: data.trackId,
          camera: data.camera ? {
            id: data.camera.id,
            name: data.camera.name,
            city: data.camera.city,
            lat: data.camera.lat,
            lng: data.camera.lng,
            zone: data.camera.zone,
          } : null,
        };

        if (global.io) {
          if (data.camera?.organization_id) {
            global.io.to(data.camera.organization_id).emit('detection:new', detectionEvent);
          } else {
            global.io.emit('detection:new', detectionEvent);
          }

          if (flagged) {
            const alertEvent = {
              id: `ALT-${uuidv4().slice(0, 8).toUpperCase()}`,
              detection_id: detId,
              plate: detection.plate,
              camera_id: detection.camera_id,
              timestamp,
              type: violationType || 'Traffic Violation',
              severity: 'warning',
              status: 'active',
              description: `Smart ANPR detected: ${violationLabels.join(' & ')} on ${detection.vehicle_type}`,
            };
            if (data.camera?.organization_id) {
              global.io.to(data.camera.organization_id).emit('alert:new', alertEvent);
            } else {
              global.io.emit('alert:new', alertEvent);
            }
          }
        }

        if (data.camera) {
          checkWatchlist({ ...detection, camera: data.camera }, global.io);
          validateDetection(detection).catch(() => {});
        }

        console.log(`[SmartANPR] ✅ Persisted ${detection.plate} (${detection.vehicle_type}) [Track: ${data.trackId || 'N/A'}] ${flagged ? '⚠️ VIOLATIONS: ' + violationType : ''}`);
        return detection;
      } else if (inserted && inserted.updated) {
        console.log(`[SmartANPR] 🔄 Updated existing detection ${inserted.id} with higher confidence plate "${detection.plate}" (was "${inserted.matchedPlate}")`);
        if (global.io) {
          global.io.emit('detection:update', { id: inserted.id, ...detection });
        }
        return { ...detection, id: inserted.id, updated: true };
      } else {
        console.log(`[SmartANPR] 🛑 Time-window dedup suppressed duplicate card for "${detection.plate}" on camera ${detection.camera_id} (matches existing ${inserted?.id} / ${inserted?.matchedPlate})`);
        return null;
      }
    } catch (err) {
      console.error(`[SmartANPR] Error persisting detection: ${err.message}`);
      return null;
    }
  }

  #emitFrame(camera, overlay, frameBuffer) {
    if (!global.io) return;
    const previewDataUri = `data:image/jpeg;base64,${frameBuffer.toString('base64')}`;
    const payload = {
      ...overlay,
      preview: previewDataUri,
    };

    if (camera?.organization_id) {
      global.io.to(camera.organization_id).emit('stream:frame', payload);
    } else {
      global.io.emit('stream:frame', payload);
    }
  }
}

// Singleton pipeline instance
const realtimeAnprPipeline = new RealtimeAnprPipeline();

module.exports = {
  RealtimeAnprPipeline,
  realtimeAnprPipeline,
};
