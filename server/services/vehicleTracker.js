// ============================================
// VisionTrack — Lightweight Vehicle Tracker
// IoU and Centroid-Overlap Multi-Frame Tracking
// ============================================
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const {
  CONFIRMATION_STATES,
  formatConfidencePercent,
  createObservation,
  evaluateTrackObservations,
} = require('./temporalAnprConfirmation');

const DEFAULT_UPLOADS_DIR = path.join(__dirname, '..', 'uploads', 'detections');

/**
 * Calculate Intersection over Union (IoU) between two bounding boxes
 * @param {object} b1 - { x, y, width, height }
 * @param {object} b2 - { x, y, width, height }
 * @returns {number} IoU in range [0, 1]
 */
function bboxIoU(b1, b2) {
  if (!b1 || !b2) return 0;
  const left = Math.max(b1.x, b2.x);
  const top = Math.max(b1.y, b2.y);
  const right = Math.min(b1.x + b1.width, b2.x + b2.width);
  const bottom = Math.min(b1.y + b1.height, b2.y + b2.height);
  const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
  const union = (b1.width * b1.height) + (b2.width * b2.height) - intersection;
  return union > 0 ? intersection / union : 0;
}

/**
 * Normalized centroid distance between two bounding boxes
 * @param {object} b1 - { x, y, width, height }
 * @param {object} b2 - { x, y, width, height }
 * @returns {number} Ratio of centroid distance to average diagonal
 */
function centroidDistanceRatio(b1, b2) {
  if (!b1 || !b2) return 1.0;
  const c1x = b1.x + b1.width / 2;
  const c1y = b1.y + b1.height / 2;
  const c2x = b2.x + b2.width / 2;
  const c2y = b2.y + b2.height / 2;
  const dist = Math.hypot(c1x - c2x, c1y - c2y);
  const diag = (Math.hypot(b1.width, b1.height) + Math.hypot(b2.width, b2.height)) / 2;
  return diag > 0 ? dist / diag : 1.0;
}

/**
 * Select the single best OCR reading from an accumulated list of readings
 * based on confidence, frequency of agreement, and plate format validity.
 *
 * @param {Array<object>} readings - Array of { plate, ocrText, confidence, ocrConfidence, frameBuffer, timestamp }
 * @returns {object|null} The best reading object
 */
function selectBestOcrReading(readings) {
  if (!readings || readings.length === 0) return null;
  if (readings.length === 1) return readings[0];

  // Group and count occurrences of normalized plates
  const counts = new Map();
  for (const r of readings) {
    if (!r.plate) continue;
    const norm = String(r.plate).toUpperCase().replace(/[^A-Z0-9]/g, '');
    counts.set(norm, (counts.get(norm) || 0) + 1);
  }

  let best = null;
  let highestScore = -1;

  for (const r of readings) {
    if (!r.plate) continue;
    const norm = String(r.plate).toUpperCase().replace(/[^A-Z0-9]/g, '');
    const freq = counts.get(norm) || 1;
    const conf = Number(r.confidence > 1 ? r.confidence / 100 : r.confidence) || 0;
    const lengthBonus = (norm.length >= 5 && norm.length <= 11) ? 0.05 : 0;
    // Weighted score: 65% confidence, 30% consistency/frequency across frames, 5% length plausibility
    const score = conf * 0.65 + (freq / readings.length) * 0.30 + lengthBonus;

    if (score > highestScore) {
      highestScore = score;
      best = r;
    }
  }

  return best || readings[0];
}

class TrackedVehicle {
  constructor(id, initialDetection, frameContext = {}) {
    this.id = id;
    this.vehicleType = initialDetection.vehicleType || initialDetection.type || 'vehicle';
    this.bbox = { ...initialDetection.bbox };
    this.firstSeenFrame = frameContext.frameIndex || 0;
    this.lastSeenFrame = frameContext.frameIndex || 0;
    this.firstSeenTime = frameContext.timestamp || new Date().toISOString();
    this.lastSeenTime = frameContext.timestamp || new Date().toISOString();
    this.framesTracked = 1;
    this.missedFrames = 0;
    this.status = 'active'; // 'active' | 'finalized'
    this.ocrReadings = [];
    this.observations = [];
    this.confirmationState = CONFIRMATION_STATES.NO_VALID_PLATE;
    this.confirmedPlate = null;
    this.shouldSkipOcr = false;
    this.lastEvaluation = null;
    this.ocrAttempts = 0;
    this.failedOcrAttempts = 0;
    this.consecutiveLowConfAttempts = 0;

    // Linear motion prediction across 500ms sampling intervals
    this.vx = 0; // pixels per frame
    this.vy = 0;
    this.vw = 0;
    this.vh = 0;
    this.prevBbox = null;

    // Violation caching to avoid redundant 150ms inferences on every frame
    this.cachedViolations = null;
    this.violationEvaluated = false;

    // Track bounding box area history to detect approaching/growing tracks
    this.bboxAreaHistory = [];
    const initialArea = (this.bbox && this.bbox.width && this.bbox.height)
      ? (this.bbox.width * this.bbox.height)
      : 0;
    if (initialArea > 0) {
      this.bboxAreaHistory.push(initialArea);
    }

    // Deferred OCR: store top-N candidate frames scored by cheap quality metric
    this.deferredOcrMode = false;
    this.candidateFrames = [];  // {cropBuffer, score, frameIndex, vehicleBbox, vehicleConf, area, sharpness}
    this.maxCandidates = 3;

    this.estimatedSpeed = (initialDetection.speed !== undefined && initialDetection.speed !== null)
      ? Number(initialDetection.speed)
      : null;

    if (initialDetection.plate || initialDetection.rawPlate || initialDetection.ocrText) {
      this.addReading(initialDetection, frameContext);
    }
  }

  /**
   * Project where this vehicle is expected to be based on velocity vector.
   * @param {number} [framesAhead=1]
   * @returns {{x: number, y: number, width: number, height: number}|null}
   */
  getPredictedBbox(framesAhead = 1) {
    if (!this.bbox) return null;
    const predX = Math.round(this.bbox.x + this.vx * framesAhead);
    const predY = Math.round(this.bbox.y + this.vy * framesAhead);
    const predW = Math.max(20, Math.round(this.bbox.width + this.vw * framesAhead));
    const predH = Math.max(15, Math.round(this.bbox.height + this.vh * framesAhead));
    return { x: predX, y: predY, width: predW, height: predH };
  }

  update(detection, frameContext = {}) {
    const prevBbox = { ...this.bbox };
    const newBbox = { ...detection.bbox };

    // Update velocity with exponential moving average (alpha = 0.6)
    const dt = Math.max(1, (frameContext.frameIndex || 0) - this.lastSeenFrame);
    const curVx = (newBbox.x - prevBbox.x) / dt;
    const curVy = (newBbox.y - prevBbox.y) / dt;
    const curVw = (newBbox.width - prevBbox.width) / dt;
    const curVh = (newBbox.height - prevBbox.height) / dt;

    this.vx = this.framesTracked <= 1 ? curVx : (this.vx * 0.4 + curVx * 0.6);
    this.vy = this.framesTracked <= 1 ? curVy : (this.vy * 0.4 + curVy * 0.6);
    this.vw = this.framesTracked <= 1 ? curVw : (this.vw * 0.4 + curVw * 0.6);
    this.vh = this.framesTracked <= 1 ? curVh : (this.vh * 0.4 + curVh * 0.6);

    this.prevBbox = prevBbox;
    this.bbox = newBbox;
    const currentArea = (detection.bbox && detection.bbox.width && detection.bbox.height)
      ? (detection.bbox.width * detection.bbox.height)
      : 0;
    if (currentArea > 0) {
      this.bboxAreaHistory.push(currentArea);
      if (this.bboxAreaHistory.length > 10) {
        this.bboxAreaHistory.shift();
      }
    }

    if (detection.vehicleType && detection.vehicleType !== 'unknown') {
      this.vehicleType = detection.vehicleType;
    }
    if (detection.speed !== undefined && detection.speed !== null) {
      this.estimatedSpeed = Number(detection.speed);
    }
    this.lastSeenFrame = frameContext.frameIndex || this.lastSeenFrame + 1;
    this.lastSeenTime = frameContext.timestamp || new Date().toISOString();
    this.framesTracked += 1;
    this.missedFrames = 0;

    if (detection.plate || detection.rawPlate || detection.ocrText) {
      this.addReading(detection, frameContext);
    }
  }

  addReading(reading, frameContext = {}) {
    if (!reading) return;

    // 1. Create structured temporal observation
    const obs = createObservation(reading, frameContext);

    // Guard against duplicate observation for the exact same frame on the same track
    const lastObs = this.observations[this.observations.length - 1];
    if (lastObs && lastObs.frameNumber === obs.frameNumber && lastObs.rawPlate === obs.rawPlate) {
      return;
    }

    this.observations.push(obs);

    // 2. Preserve legacy reading object for backwards compatibility
    this.ocrReadings.push({
      plate: obs.normalizedPlate || reading.plate,
      rawPlate: obs.rawPlate,
      ocrText: reading.ocrText || reading.ocr_text || obs.rawPlate,
      confidence: obs.ocrConfidence,
      ocrConfidence: reading.ocrConfidence ?? Math.round(obs.ocrConfidence * 100),
      plateConfidence: obs.plateDetectorConfidence,
      frameBuffer: obs.frameBuffer,
      timestamp: obs.frameTimestamp,
      frameNumber: obs.frameNumber,
      vehicleType: this.vehicleType,
    });

    // 3. Evaluate multi-frame temporal consensus
    const prevConfirmed = this.confirmedPlate;
    const evaluation = evaluateTrackObservations(this.observations);
    this.confirmationState = evaluation.state;
    this.confirmedPlate = evaluation.confirmedPlate;
    this.shouldSkipOcr = evaluation.shouldSkipOcr;
    this.lastEvaluation = evaluation;

    // FIX (Bug 2b): Record how many OCR attempts existed when the plate was FIRST confirmed.
    // This lets shouldRunOcrNow() accurately count post-confirmation correction attempts.
    if (!prevConfirmed && this.confirmedPlate && this._preConfirmOcrAttempts === undefined) {
      this._preConfirmOcrAttempts = this.ocrAttempts;
    }
  }

  recordOcrAttempt(result = null) {
    this.ocrAttempts += 1;
    const conf = result ? Number(result.finalConfidence || result.confidence || result.ocrConfidence || 0) : 0;
    const unitConf = conf > 1 ? conf / 100 : conf;
    const hasValidPlate = Boolean(result?.plate);

    if (!hasValidPlate || unitConf < 0.30) {
      this.failedOcrAttempts += 1;
      this.consecutiveLowConfAttempts += 1;
    } else {
      this.consecutiveLowConfAttempts = 0;
    }
  }

  /**
   * Determine if a vehicle is currently approaching (crop size growing frame-over-frame).
   * @param {object} [currentBbox] - Bounding box of the current frame detection
   * @returns {boolean}
   */
  isApproaching(currentBbox = null) {
    let areaNow = 0;
    if (currentBbox && currentBbox.width && currentBbox.height) {
      areaNow = currentBbox.width * currentBbox.height;
    } else if (this.bbox && this.bbox.width && this.bbox.height) {
      areaNow = this.bbox.width * this.bbox.height;
    }

    if (areaNow === 0) return false;

    if (this.bboxAreaHistory && this.bboxAreaHistory.length > 0) {
      const lastHist = this.bboxAreaHistory[this.bboxAreaHistory.length - 1];
      if (currentBbox && areaNow > lastHist * 1.005) {
        return true;
      }
      if (this.bboxAreaHistory.length >= 2) {
        const prevHist = this.bboxAreaHistory[this.bboxAreaHistory.length - 2];
        if (lastHist > prevHist * 1.005) {
          return true;
        }
      }
    }
    return false;
  }

  shouldThrottleOcr(currentFrameNumber, currentBbox = null) {
    if (this.shouldSkipOcr) return true;

    // Do NOT throttle or back off on a track that's still growing in size (approaching)
    if (this.isApproaching(currentBbox)) {
      return false;
    }

    // Only throttle tracks that are NOT getting closer (stable or shrinking crop size) after repeated failures
    if (this.failedOcrAttempts >= 2 || this.consecutiveLowConfAttempts >= 2) {
      const frameNum = (currentFrameNumber != null) ? currentFrameNumber : this.framesTracked;
      const stride = this.failedOcrAttempts >= 5 ? 5 : 3;
      if (frameNum % stride !== 0) {
        return true;
      }
    }
    return false;
  }

  /**
   * Determine if OCR should be executed on this frame for this vehicle.
   * Commercial ANPR principle: execute at peak optical resolution, not repeatedly.
   *
   * @param {object} qualityResult - Quality score result from scoreCropQuality()
   * @param {number} currentFrameSeq - Frame index
   * @returns {boolean}
   */
  shouldRunOcrNow(qualityResult = null, currentFrameSeq = 0) {
    if (this.shouldSkipOcr) return false;

    // FIX (Bug 2): If plate is confirmed, allow up to 2 post-confirmation correction attempts
    // when the vehicle is still approaching (larger/sharper crop available).
    // Previously this returned false immediately, permanently locking in a potentially wrong read
    // from an early blurry crop before the vehicle was close enough.
    if (this.confirmedPlate) {
      const preConfirmAttempts = this._preConfirmOcrAttempts ?? this.ocrAttempts;
      const postConfirmAttempts = this.ocrAttempts - preConfirmAttempts;
      if (postConfirmAttempts >= 2) return false; // Cap at 2 correction attempts post-confirmation
      // Only bother correcting if vehicle is still approaching (better resolution incoming)
      return this.isApproaching();
    }

    // If no OCR attempts made yet:
    if (this.ocrAttempts === 0) {
      // 1. Clear, high-resolution crop reached
      if (qualityResult && qualityResult.area >= 8000 && qualityResult.sharpness >= 25) {
        return true;
      }
      // 2. Sizable vehicle crop after at least 1 tracking frame
      if (this.framesTracked >= 2 && this.bbox && this.bbox.width >= 90) {
        return true;
      }
      // 3. Track has been seen across 3 frames: trigger OCR so it's not missed
      if (this.framesTracked >= 3) {
        return true;
      }
      return false;
    }

    // If already attempted once and failed/unconfirmed:
    // Only retry if crop size is growing (approaching) or every 3rd-4th frame
    if (this.isApproaching()) {
      return this.framesTracked % 2 === 0;
    }

    return this.framesTracked % 4 === 0;
  }

  /**
   * Store a candidate frame for deferred OCR.
   * Keeps only the top-N (default 3) highest-scored candidates.
   *
   * @param {Buffer} cropBuffer - Vehicle crop buffer
   * @param {object} qualityResult - Output from scoreCropQuality()
   * @param {number} frameIndex - Frame number
   * @param {object} vehicleBbox - Vehicle bounding box
   */
  addCandidateFrame(cropBuffer, qualityResult, frameIndex, vehicleBbox) {
    if (!cropBuffer || !qualityResult) return;
    if (qualityResult.tooSmall) return; // skip crops too small to contain a plate

    const candidate = {
      cropBuffer,
      score: qualityResult.score,
      area: qualityResult.area,
      sharpness: qualityResult.sharpness,
      detConf: qualityResult.detConf,
      frameIndex,
      vehicleBbox: vehicleBbox ? { ...vehicleBbox } : null,
    };

    // Insert in sorted order (descending score), cap at maxCandidates
    this.candidateFrames.push(candidate);
    this.candidateFrames.sort((a, b) => b.score - a.score);
    if (this.candidateFrames.length > this.maxCandidates) {
      // Drop the worst candidate and release its buffer reference
      this.candidateFrames.pop();
    }
  }

  /**
   * Get the best candidate frames for deferred OCR, sorted by quality score descending.
   * @returns {Array<object>}
   */
  getBestCandidates() {
    return this.candidateFrames.slice();
  }

  getConfirmation() {
    return evaluateTrackObservations(this.observations);
  }

  getBestReading() {
    const evaluation = evaluateTrackObservations(this.observations);
    if (!evaluation || !evaluation.authoritativeReading) {
      return selectBestOcrReading(this.ocrReadings);
    }
    const auth = evaluation.authoritativeReading;
    return {
      plate: evaluation.confirmedPlate || evaluation.candidatePlate || auth.normalizedPlate || auth.rawPlate,
      rawPlate: auth.rawPlate,
      ocrText: auth.rawPlate,
      confidence: auth.ocrConfidence,
      temporalConfidence: evaluation.confidence,
      ocrConfidence: Math.round(auth.ocrConfidence * 100),
      plateConfidence: auth.plateDetectorConfidence,
      timestamp: auth.frameTimestamp,
      frameNumber: auth.frameNumber,
      frameBuffer: auth.frameBuffer,
      confirmationState: evaluation.state,
      confirmedPlate: evaluation.confirmedPlate,
      candidatePlate: evaluation.candidatePlate,
      agreementCount: evaluation.agreementCount,
      totalObservations: evaluation.totalObservations,
      validObservations: evaluation.validObservations,
      margin: evaluation.margin,
      shouldSkipOcr: evaluation.shouldSkipOcr,
      observations: this.observations,
    };
  }
}

class VehicleTracker {
  constructor(options = {}) {
    this.sampleFps = Number(options.sampleFps || options.fps || 16);
    this.maxMissedTimeSec = Number(options.maxMissedTimeSec ?? 1.8);
    this.maxMissedFrames = Number(options.maxMissedFrames ?? Math.max(15, Math.round(this.sampleFps * this.maxMissedTimeSec)));
    this.iouThreshold = Number(options.iouThreshold ?? 0.20);
    this.maxCentroidDistanceRatio = Number(options.maxCentroidDistanceRatio ?? 0.75);
    this.uploadsDir = options.uploadsDir || DEFAULT_UPLOADS_DIR;
    this.onTrackFinalized = options.onTrackFinalized || null;

    // Deferred OCR mode: defer OCR to finalization
    this.deferOcr = Boolean(options.deferOcr);
    this.ocrFunction = options.ocrFunction || null; // processPlateImage reference for deferred OCR

    this.activeTracks = new Map(); // trackId -> TrackedVehicle
    this.finalizedTracks = [];
    this.recentFinalizedTracks = []; // FIFO buffer for track stitching / re-identification
    this.nextTrackSeq = 1;
  }

  /**
   * Dynamically update sample FPS and adjust maxMissedFrames
   */
  setFps(fps) {
    if (fps && fps > 0) {
      this.sampleFps = Number(fps);
      this.maxMissedFrames = Math.max(15, Math.round(this.sampleFps * this.maxMissedTimeSec));
    }
  }

  /**
   * Match an incoming detection bbox with active tracks using both
   * static geometry and velocity-based motion prediction.
   * Also checks recently finalized tracks for trajectory / plate stitching.
   */
  findBestMatch(detBbox, detPlate = null, frameIndex = 0) {
    let bestTrack = null;
    let highestScore = -1;

    for (const track of this.activeTracks.values()) {
      // 1. Static geometric comparison
      const iouStatic = bboxIoU(track.bbox, detBbox);
      const cDistRatioStatic = centroidDistanceRatio(track.bbox, detBbox);

      // 2. Motion-predicted comparison (projected across missed frames)
      const predBbox = track.getPredictedBbox(track.missedFrames + 1);
      const iouPred = predBbox ? bboxIoU(predBbox, detBbox) : 0;
      const cDistRatioPred = predBbox ? centroidDistanceRatio(predBbox, detBbox) : 1.0;

      // Select highest affinity between static and motion-predicted
      const iou = Math.max(iouStatic, iouPred);
      const cDistRatio = Math.min(cDistRatioStatic, cDistRatioPred);

      // Size-adaptive matching: small distant vehicles (<70px) move faster relative to their size
      const isSmallVehicle = (detBbox.width < 70 || detBbox.height < 50);
      const effectiveIouThreshold = isSmallVehicle ? Math.max(0.08, this.iouThreshold * 0.5) : this.iouThreshold;
      const effectiveCentroidRatio = isSmallVehicle ? Math.min(1.2, this.maxCentroidDistanceRatio * 1.4) : this.maxCentroidDistanceRatio;

      const isIoUMatch = iou >= effectiveIouThreshold;
      const isCentroidMatch = cDistRatio <= effectiveCentroidRatio && iou >= 0.03;
      const isTightCentroid = cDistRatio <= (isSmallVehicle ? 0.45 : 0.35);

      if (isIoUMatch || isCentroidMatch || isTightCentroid) {
        // Combined match affinity: 65% IoU + 35% proximity
        let affinity = iou * 0.65 + (1 - Math.min(1, cDistRatio)) * 0.35;
        // Bonus if plate matches
        if (detPlate && track.confirmedPlate && detPlate === track.confirmedPlate) {
          affinity += 0.5;
        }
        if (affinity > highestScore) {
          highestScore = affinity;
          bestTrack = track;
        }
      }
    }

    if (bestTrack) return bestTrack;

    // Track Stitching: check recently finalized tracks
    const now = Date.now();
    for (let i = this.recentFinalizedTracks.length - 1; i >= 0; i--) {
      const rec = this.recentFinalizedTracks[i];
      const ageMs = now - rec.finalizedAt;
      if (ageMs > 5000) {
        this.recentFinalizedTracks.splice(i, 1);
        continue;
      }

      const deltaFrames = Math.max(1, frameIndex - rec.finalizedFrame);
      if (deltaFrames > this.maxMissedFrames * 2) continue;

      // Check plate match first
      const plateMatch = detPlate && (
        rec.confirmedPlate === detPlate ||
        rec.plates.includes(detPlate)
      );

      // Check trajectory continuity
      const predX = Math.round(rec.lastBbox.x + rec.vx * deltaFrames);
      const predY = Math.round(rec.lastBbox.y + rec.vy * deltaFrames);
      const predW = rec.lastBbox.width;
      const predH = rec.lastBbox.height;
      const predBbox = { x: predX, y: predY, width: predW, height: predH };

      const iou = Math.max(bboxIoU(rec.lastBbox, detBbox), bboxIoU(predBbox, detBbox));
      const cDist = Math.min(
        centroidDistanceRatio(rec.lastBbox, detBbox),
        centroidDistanceRatio(predBbox, detBbox)
      );

      const areaRatio = (detBbox.width * detBbox.height) / Math.max(1, rec.lastBbox.width * rec.lastBbox.height);
      const isSizeCompatible = areaRatio >= 0.4 && areaRatio <= 2.5;

      if ((plateMatch && (iou > 0.02 || cDist < 1.0)) || (isSizeCompatible && (iou >= 0.15 || cDist <= 0.65))) {
        // Stitch / Re-activate track!
        const stitchedTrack = rec.track;
        stitchedTrack.status = 'active';
        stitchedTrack.missedFrames = 0;
        this.recentFinalizedTracks.splice(i, 1);

        // Remove from finalizedTracks if present
        const finIdx = this.finalizedTracks.findIndex(f => f.trackId === stitchedTrack.id);
        if (finIdx !== -1) {
          this.finalizedTracks.splice(finIdx, 1);
        }

        return stitchedTrack;
      }
    }

    return null;
  }

  /**
   * Process a single frame's detections
   *
   * @param {Array<object>} detections - Array of vehicle detections { bbox, vehicleType, plate, ocrText, confidence }
   * @param {object} frameContext - { frameIndex, timestamp, frameBuffer }
   * @returns {Promise<{ activeTracks: Array<TrackedVehicle>, finalized: Array<object> }>}
   */
  async update(detections = [], frameContext = {}) {
    const matchedTrackIds = new Set();
    const newlyFinalized = [];
    const frameIndex = frameContext.frameIndex || 0;

    // 1. Associate incoming detections with existing active tracks or stitched tracks
    for (const det of detections) {
      if (!det.bbox) continue;
      const detPlate = det.plate || det.rawPlate || null;
      const matchedTrack = this.findBestMatch(det.bbox, detPlate, frameIndex);

      if (matchedTrack && !matchedTrackIds.has(matchedTrack.id)) {
        // If track was inactive (stitched from recent finalized), add back to activeTracks
        if (!this.activeTracks.has(matchedTrack.id)) {
          this.activeTracks.set(matchedTrack.id, matchedTrack);
        }
        matchedTrack.update(det, frameContext);
        matchedTrackIds.add(matchedTrack.id);
        det.trackId = matchedTrack.id;
        det.shouldSkipOcr = matchedTrack.shouldSkipOcr;
        det.confirmationState = matchedTrack.confirmationState;
        det.confirmedPlate = matchedTrack.confirmedPlate;
      } else {
        // Unmatched detection: spawn new track
        const trackId = `TRK-${String(this.nextTrackSeq++).padStart(3, '0')}`;
        const newTrack = new TrackedVehicle(trackId, det, frameContext);
        if (this.deferOcr) newTrack.deferredOcrMode = true;
        this.activeTracks.set(trackId, newTrack);
        matchedTrackIds.add(trackId);
        det.trackId = trackId;
        det.shouldSkipOcr = newTrack.shouldSkipOcr;
        det.confirmationState = newTrack.confirmationState;
        det.confirmedPlate = newTrack.confirmedPlate;
      }
    }

    // 2. Identify active tracks that had no match in this frame
    const tracksToFinalize = [];
    for (const [trackId, track] of this.activeTracks.entries()) {
      if (!matchedTrackIds.has(trackId)) {
        track.missedFrames += 1;
        if (track.missedFrames >= this.maxMissedFrames) {
          tracksToFinalize.push(trackId);
        }
      }
    }

    // 3. Finalize ended tracks
    for (const trackId of tracksToFinalize) {
      const track = this.activeTracks.get(trackId);
      this.activeTracks.delete(trackId);
      const finalized = await this.#finalizeTrack(track);
      if (finalized) newlyFinalized.push(finalized);
    }

    return {
      activeTracks: [...this.activeTracks.values()],
      finalized: newlyFinalized,
    };
  }

  /**
   * Propagate active tracks on interleaved high-FPS frames using linear motion prediction
   * without requiring full deep neural network detection.
   *
   * @param {object} frameContext - { frameIndex, timestamp, frameBuffer }
   * @returns {{ activeTracks: Array<TrackedVehicle>, finalized: Array<object> }}
   */
  propagateInterleaved(frameContext = {}) {
    for (const track of this.activeTracks.values()) {
      const predBbox = track.getPredictedBbox(1);
      if (predBbox) {
        track.bbox = predBbox;
      }
      track.framesTracked += 1;
      track.lastSeenFrame = frameContext.frameIndex || (track.lastSeenFrame + 1);
      track.lastSeenTime = frameContext.timestamp || new Date().toISOString();
    }
    return {
      activeTracks: [...this.activeTracks.values()],
      finalized: [],
    };
  }

  /**
   * Finalize a track: select the single best reading, save snapshot, trigger callbacks.
   * In deferred OCR mode, runs OCR on the best 1-3 stored candidate frames.
   */
  async #finalizeTrack(track) {
    track.status = 'finalized';

    // === DEFERRED OCR: run OCR on best candidates at finalization ===
    if (track.deferredOcrMode && track.candidateFrames.length > 0 && this.ocrFunction) {
      const candidates = track.getBestCandidates();
      let bestOcrResult = null;
      let bestOcrConf = -1;
      let deferredOcrCalls = 0;

      for (const cand of candidates) {
        try {
          deferredOcrCalls++;
          const ocrResult = await this.ocrFunction(cand.cropBuffer);
          if (ocrResult?.plate) {
            const conf = Number(ocrResult.finalConfidence || ocrResult.confidence || 0);
            const unitConf = conf > 1 ? conf / 100 : conf;
            if (unitConf > bestOcrConf) {
              bestOcrConf = unitConf;
              bestOcrResult = ocrResult;
              bestOcrResult._candidateFrameIndex = cand.frameIndex;
              bestOcrResult._candidateScore = cand.score;
            }
            // If first result is high-confidence + valid format, skip remaining candidates
            if (unitConf >= 0.75) break;
          }
        } catch (err) {
          console.warn(`[VehicleTracker] Deferred OCR error on candidate: ${err.message}`);
        }
      }

      // If deferred OCR produced a result, add it as a reading to the track
      if (bestOcrResult?.plate) {
        track.addReading({
          plate: bestOcrResult.plate,
          rawPlate: bestOcrResult.rawText || bestOcrResult.plate,
          ocrText: bestOcrResult.rawText || bestOcrResult.plate,
          confidence: bestOcrConf,
          ocrConfidence: Math.round(bestOcrConf * 100),
          plateConfidence: bestOcrResult.detectorConfidence || 0,
          frameBuffer: candidates[0]?.cropBuffer,
        }, {
          frameIndex: bestOcrResult._candidateFrameIndex,
          timestamp: new Date().toISOString(),
        });
      }
      track._deferredOcrCalls = deferredOcrCalls;
    }

    const bestReading = track.getBestReading();

    let imagePath = null;
    let detId = null;

    if (bestReading && bestReading.frameBuffer) {
      detId = `DET-${uuidv4().slice(0, 8).toUpperCase()}`;
      try {
        await fs.promises.mkdir(this.uploadsDir, { recursive: true });
        const fileName = `snap_${detId}_${Date.now()}.jpg`;
        const filePath = path.join(this.uploadsDir, fileName);
        await fs.promises.writeFile(filePath, bestReading.frameBuffer);
        imagePath = `/uploads/detections/${fileName}`;
      } catch (err) {
        console.warn(`[VehicleTracker] Could not save frame snapshot: ${err.message}`);
      }
    }

    const finalizedRecord = {
      trackId: track.id,
      vehicleType: track.vehicleType,
      framesTracked: track.framesTracked,
      totalReadings: track.ocrReadings.length,
      hasPlate: Boolean(bestReading?.plate),
      confirmationState: track.confirmationState,
      confirmedPlate: track.confirmedPlate,
      speed: track.estimatedSpeed ?? null,
      bestReading: bestReading ? {
        plate: bestReading.plate,
        rawPlate: bestReading.rawPlate,
        ocrText: bestReading.ocrText,
        confidence: bestReading.confidence,
        ocrConfidence: bestReading.ocrConfidence,
        plateConfidence: bestReading.plateConfidence,
        timestamp: bestReading.timestamp,
        confirmationState: bestReading.confirmationState || track.confirmationState,
        confirmedPlate: bestReading.confirmedPlate || track.confirmedPlate,
        agreementCount: bestReading.agreementCount,
        imagePath,
        detId,
      } : null,
      allReadings: track.ocrReadings.map(r => ({
        plate: r.plate,
        confidence: r.confidence,
        timestamp: r.timestamp,
      })),
      observations: track.observations,
      track,
    };

    // Record into recentFinalizedTracks for trajectory / plate re-identification
    this.recentFinalizedTracks.push({
      track,
      finalizedAt: Date.now(),
      finalizedFrame: track.lastSeenFrame,
      lastBbox: { ...track.bbox },
      vx: track.vx,
      vy: track.vy,
      confirmedPlate: track.confirmedPlate,
      plates: track.ocrReadings.map(r => r.plate).filter(Boolean),
    });
    if (this.recentFinalizedTracks.length > 50) {
      this.recentFinalizedTracks.shift();
    }

    this.finalizedTracks.push(finalizedRecord);

    if (typeof this.onTrackFinalized === 'function') {
      try {
        await this.onTrackFinalized(finalizedRecord);
      } catch (err) {
        console.error(`[VehicleTracker] onTrackFinalized callback error: ${err.message}`);
      }
    }

    return finalizedRecord;
  }

  /**
   * Finalize all active tracks immediately (called on stream finish / stop)
   */
  async finalizeAll() {
    const finalized = [];
    const remainingTrackIds = [...this.activeTracks.keys()];

    for (const trackId of remainingTrackIds) {
      const track = this.activeTracks.get(trackId);
      this.activeTracks.delete(trackId);
      const rec = await this.#finalizeTrack(track);
      if (rec) finalized.push(rec);
    }

    // Plate-based Track Stitching / Deduplication across finalized records:
    // If multiple finalized records share the exact same confirmedPlate (or Levenshtein <= 1)
    // within 5 seconds, merge them into the canonical record so the physical vehicle count is preserved.
    const merged = [];
    for (const rec of finalized) {
      const plate = rec.bestReading?.plate || rec.confirmedPlate;
      if (!plate) {
        merged.push(rec);
        continue;
      }
      const existing = merged.find(m => {
        const mPlate = m.bestReading?.plate || m.confirmedPlate;
        if (!mPlate) return false;
        if (mPlate === plate) return true;
        // Check Levenshtein distance <= 1 for plates with same length
        if (mPlate.length === plate.length && mPlate.length >= 8) {
          let diff = 0;
          for (let i = 0; i < plate.length; i++) {
            if (plate[i] !== mPlate[i]) diff++;
            if (diff > 1) break;
          }
          return diff <= 1;
        }
        return false;
      });

      if (existing) {
        // Merge into existing record: combine frames, readings, observations
        existing.framesTracked += rec.framesTracked;
        existing.totalReadings += rec.totalReadings;
        if (rec.allReadings) {
          existing.allReadings.push(...rec.allReadings);
        }
        if (rec.observations) {
          existing.observations.push(...rec.observations);
        }
        // Update bestReading if current has higher confidence
        if (rec.bestReading?.confidence > (existing.bestReading?.confidence || 0)) {
          existing.bestReading = rec.bestReading;
          existing.confirmedPlate = rec.confirmedPlate || existing.confirmedPlate;
        }
      } else {
        merged.push(rec);
      }
    }

    return merged;
  }

  /**
   * Check if an active track has reached confirmed status and can skip repeated OCR
   */
  shouldSkipOcrForTrack(trackId) {
    const track = this.activeTracks.get(trackId);
    return Boolean(track && track.shouldSkipOcr);
  }

  /**
   * Reset tracker state
   */
  reset() {
    this.activeTracks.clear();
    this.finalizedTracks = [];
    this.nextTrackSeq = 1;
  }
}

module.exports = {
  VehicleTracker,
  TrackedVehicle,
  bboxIoU,
  centroidDistanceRatio,
  selectBestOcrReading,
  CONFIRMATION_STATES,
  formatConfidencePercent,
  createObservation,
  evaluateTrackObservations,
};
