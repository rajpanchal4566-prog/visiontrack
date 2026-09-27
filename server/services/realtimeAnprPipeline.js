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
    this.maxMissedFrames = Number(options.maxMissedFrames ?? Math.max(4, Math.round(this.sampleFps * this.maxMissedTimeSec)));
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
        maxMissedFrames: Math.max(4, Math.round(fps * this.maxMissedTimeSec)),
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
            frameBuffer: fin.bestReading.vehicleCropBuffer || fin.bestReading.frameBuffer,
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

    // Stage 1: Frame Pre-Check & Native Resolution Alignment
    const tResize0 = Date.now();
    let origMeta = null;
    try {
      origMeta = await sharp(frameBuffer).metadata();
    } catch {
      origMeta = { width: 1280, height: 720 };
    }
    // Use native frameBuffer directly for maximum detection resolution and 1:1 pixel coordinate alignment.
    // Only downsample if oversized (>1920) to prevent memory spikes.
    const activeFrame = (origMeta.width > 1920 || origMeta.height > 1080)
      ? await resizeFrameForYolo(frameBuffer, 1280)
      : frameBuffer;
    const activeMeta = (activeFrame === frameBuffer)
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
        violations: singleTrack?.cachedViolations?.violations || [],
        flagged: Boolean(singleTrack?.cachedViolations?.violations?.length > 0),
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
        violations: singleTrack?.cachedViolations?.violations || [],
        flagged: Boolean(singleTrack?.cachedViolations?.violations?.length > 0),
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

    let hasVehicle = vehicleResult.vehicle_detected;
    let detectedVehicleType = vehicleResult.detected_vehicle_type || 'unknown';
    const vehicleBbox = vehicleResult.vehicle_bbox || null;
    const occupants = vehicleResult.occupants || [];

    // Stage 3: Fast License Plate Detection (YOLOv8 Plate Detector)
    // Run if vehicle was detected OR if active tracks are currently tracking
    const tPlate0 = Date.now();
    let plateDet = null;
    if (hasVehicle || tracker.activeTracks.size > 0) {
      try {
        plateDet = await detectPlate(activeFrame);
      } catch (err) {
        console.warn(`[SmartANPR] Plate detector error: ${err.message}`);
      }
    }

    const detectedPlates = plateDet?.success ? (plateDet.detections || []) : [];
    if (detectedPlates.length > 0) {
      hasVehicle = true;
    }

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
            frameBuffer: fin.bestReading.vehicleCropBuffer || fin.bestReading.frameBuffer || activeFrame,
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

    // Step 1: Deduplicate / Class-Agnostic NMS on raw vehicle detections (IoU >= 0.70)
    let rawVehicles = (vehicleResult.vehicle_detections && vehicleResult.vehicle_detections.length > 0)
      ? [...vehicleResult.vehicle_detections]
      : (vehicleBbox ? [{ vehicle_type: detectedVehicleType, vehicle_bbox: vehicleBbox, vehicle_confidence: vehicleResult.vehicle_confidence || 0.8 }] : []);

    if (rawVehicles.length > 1) {
      const deduped = [];
      const sortedVehicles = [...rawVehicles].sort((a, b) => (b.vehicle_confidence || b.confidence || 0) - (a.vehicle_confidence || a.confidence || 0));
      for (const v of sortedVehicles) {
        const vb = v.vehicle_bbox || v.bbox;
        if (!vb) continue;
        const isDuplicate = deduped.some(existing => {
          const eb = existing.vehicle_bbox || existing.bbox;
          if (!eb) return false;
          return bboxIoU(vb, eb) >= 0.70;
        });
        if (!isDuplicate) deduped.push(v);
      }
      rawVehicles = deduped;
    }

    // Step 2 (PROBLEM 1): Track vehicles across frames using Spatial Overlap + Velocity Prediction
    const tTrack0 = Date.now();
    const vehicleDetections = rawVehicles.map(rv => ({
      bbox: rv.vehicle_bbox || rv.bbox,
      vehicleType: rv.vehicle_type || rv.type || detectedVehicleType || 'car',
      confidence: rv.vehicle_confidence ?? rv.confidence ?? 0.8,
    }));

    const trackingUpdate = await tracker.update(vehicleDetections, {
      frameIndex: frameSeq,
      timestamp: overlay.timestamp,
      frameBuffer: activeFrame,
    });
    timings.trackingMs = Date.now() - tTrack0;

    // Step 4 (PROBLEM 2): Strict Geometric Plate Ownership
    // A plate strictly belongs to whichever active vehicle box in this frame CONTAINS its coordinates.
    // If a plate's coordinates don't fall inside any vehicle box, it does not get assigned to anything.
    // Never assign one plate to multiple vehicles in the same frame.

    let primaryOcrResult = null;
    let primaryPlate = null;

    if (detectedPlates.length > 0 && trackingUpdate.activeTracks.length > 0) {

      const assignedPlates = new Set();
      const assignedTracks = new Set();

      for (let pIdx = 0; pIdx < detectedPlates.length; pIdx++) {
        const pb = detectedPlates[pIdx];
        const pcx = pb.x + pb.width / 2;
        const pcy = pb.y + pb.height / 2;

        let bestTrack = null;
        let smallestArea = Infinity;

        // PROBLEM 2: Plate ownership strictly against vehicle detections active in THIS frame (no ghost/missed tracks)
        for (const det of vehicleDetections) {
          if (!det.trackId || assignedTracks.has(det.trackId)) continue;
          const vb = det.bbox;
          if (!vb) continue;
          // Strict geometric containment: plate center MUST be inside vehicle box
          const isContained = (pcx >= vb.x && pcx <= vb.x + vb.width && pcy >= vb.y && pcy <= vb.y + vb.height);
          if (isContained) {
            const area = vb.width * vb.height;
            if (area < smallestArea) {
              smallestArea = area;
              bestTrack = tracker.activeTracks.get(det.trackId);
            }
          }
        }

        if (bestTrack && !assignedPlates.has(pIdx)) {
          assignedPlates.add(pIdx);
          assignedTracks.add(bestTrack.id);

          try {
            const highResPb = (scaleX !== 1 || scaleY !== 1) ? {
              x: Math.round(pb.x * scaleX),
              y: Math.round(pb.y * scaleY),
              width: Math.round(pb.width * scaleX),
              height: Math.round(pb.height * scaleY),
              confidence: pb.confidence,
            } : pb;

            const cropLeft = Math.max(0, Math.min(origMeta.width - 1, highResPb.x));
            const cropTop = Math.max(0, Math.min(origMeta.height - 1, highResPb.y));
            const cropW = Math.max(10, Math.min(origMeta.width - cropLeft, highResPb.width));
            const cropH = Math.max(6, Math.min(origMeta.height - cropTop, highResPb.height));

            const tightCrop = await sharp(frameBuffer)
              .extract({ left: cropLeft, top: cropTop, width: cropW, height: cropH })
              .png()
              .toBuffer();

            // Create a vehicle crop from the full frame for the evidence snapshot
            // (the plate crop is too small for humans to identify the vehicle)
            let vehicleCropBuffer = null;
            try {
              const vb = bestTrack.bbox;
              if (vb && vb.width >= 20 && vb.height >= 20) {
                // Scale vehicle bbox to original frame coords if needed
                const vbX = Math.round((scaleX !== 1 ? vb.x * scaleX : vb.x));
                const vbY = Math.round((scaleY !== 1 ? vb.y * scaleY : vb.y));
                const vbW = Math.round((scaleX !== 1 ? vb.width * scaleX : vb.width));
                const vbH = Math.round((scaleY !== 1 ? vb.height * scaleY : vb.height));
                // Add 15% padding around the vehicle for context
                const padX = Math.round(vbW * 0.15);
                const padY = Math.round(vbH * 0.15);
                const vLeft = Math.max(0, vbX - padX);
                const vTop = Math.max(0, vbY - padY);
                const vRight = Math.min(origMeta.width, vbX + vbW + padX);
                const vBottom = Math.min(origMeta.height, vbY + vbH + padY);
                const vCropW = Math.max(40, vRight - vLeft);
                const vCropH = Math.max(40, vBottom - vTop);
                vehicleCropBuffer = await sharp(frameBuffer)
                  .extract({ left: vLeft, top: vTop, width: vCropW, height: vCropH })
                  .jpeg({ quality: 88 })
                  .toBuffer();
              }
            } catch (_vCropErr) {
              // Non-fatal: fall back to plate crop for snapshot
            }

            const enhancedResult = await recognizePlateNeuralEnhanced(tightCrop, INDIA_MODEL_PATH);
            if (enhancedResult && (enhancedResult.plate || enhancedResult.rawText)) {
              const rawText = enhancedResult.rawText || enhancedResult.plate || '';
              const norm = normalizePlateText(enhancedResult.plate || rawText);
              const conf = enhancedResult.confidencePercent || (enhancedResult.confidence * 100) || 0;
              const hasValidFormat = norm.plate && (isIndianPlateFormat(norm.plate) || isStandardPlateFormat(norm.plate));

              // Reject known non-registration text patterns (category labels on Indian plates)
              const stripped = rawText.toUpperCase().replace(/[^A-Z0-9]/g, '');
              const NON_PLATE_PATTERNS = /^(NONTRANSPORT|TRANSPORT|INDIA|GOVERNMENT|PRIVATE|COMMERCIAL|DIPLOMAT|TEMPORARY|TOURIST|DEFENCE|ARMY|NAVY|AIRFORCE|POLICE|AMBULANCE|MINISTRY|PARKING)$/;
              const isNonPlateText = NON_PLATE_PATTERNS.test(stripped);

              // Non-format-validated plates must contain at least 2 digits and be 5-12 chars
              const digitCount = (stripped.match(/\d/g) || []).length;
              const isPlausiblePlate = !isNonPlateText && stripped.length >= 5 && stripped.length <= 12 && digitCount >= 2;

              const effectivePlate = norm.plate || (conf >= 25 && isPlausiblePlate ? stripped : null);

              if (effectivePlate && (hasValidFormat || (conf >= 25 && isPlausiblePlate))) {
                const reading = {
                  plate: effectivePlate,
                  rawPlate: rawText,
                  rawText,
                  confidence: conf / 100,
                  ocrConfidence: conf,
                  detectorConfidence: pb.confidence * 100,
                  plateRegion: pb,
                  frameBuffer: tightCrop,
                  vehicleCropBuffer: vehicleCropBuffer || null,
                  skippedOcr: false,
                };

                bestTrack.addReading(reading, {
                  frameIndex: frameSeq,
                  timestamp: overlay.timestamp,
                  frameBuffer: tightCrop,
                  vehicleCropBuffer: vehicleCropBuffer || null,
                });

                if (!primaryOcrResult || reading.confidence > (primaryOcrResult.confidence || 0)) {
                  primaryOcrResult = reading;
                  primaryPlate = effectivePlate;
                }
              }
            }
          } catch (err) {
            console.warn(`[SmartANPR] Plate OCR error: ${err.message}`);
          }
        }
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
    const existingTrackMatch = vehicleBbox ? tracker.findBestMatch(vehicleBbox) : null;
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
          frameBuffer: finalized.bestReading.vehicleCropBuffer || finalized.bestReading.frameBuffer || activeFrame,
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
        // Upscale small plate crops for human readability
        let snapshotBuffer = data.frameBuffer;
        try {
          const snapMeta = await sharp(snapshotBuffer).metadata();
          if (snapMeta && snapMeta.width && snapMeta.width < 300) {
            const scale = Math.min(4, Math.max(2, Math.ceil(300 / snapMeta.width)));
            snapshotBuffer = await sharp(snapshotBuffer)
              .resize({
                width: snapMeta.width * scale,
                height: snapMeta.height * scale,
                kernel: sharp.kernel.lanczos3,
              })
              .sharpen({ sigma: 1.0, m1: 1.5, m2: 0.7 })
              .jpeg({ quality: 92 })
              .toBuffer();
          }
        } catch (_upscaleErr) {
          // Fall back to original buffer if upscale fails
        }
        await fs.promises.writeFile(filePath, snapshotBuffer);
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
