// ============================================
// VisionTrack — Real-Life Multi-Violation Detector
// Evaluates every frame for:
// 1. Helmet Violation (two-wheelers with unhelmeted riders)
// 2. Seatbelt Violation (four-wheelers with unbelted drivers)
// 3. Overspeeding / Speeding Violation (frame-to-frame tracking vs camera limit)
// ============================================
const sharp = require('sharp');
const { investigateDetection } = require('./detectionInvestigator');
const helmetDetector = require('./helmetDetector');
const seatbeltClassifier = require('./seatbeltClassifier');

const DEFAULT_SPEED_LIMIT = 50;
const PIXELS_PER_METER_DEFAULT = 18; // Typical CCTV calibration

/**
 * Calculate Intersection over Union (IoU) between two bounding boxes
 */
function bboxIoU(b1, b2) {
  if (!b1 || !b2) return 0;
  const left = Math.max(b1.x, b2.x);
  const top = Math.max(b1.y, b2.y);
  const right = Math.min(b1.x + b1.width, b2.x + b2.width);
  const bottom = Math.min(b1.y + b1.height, b2.y + b2.height);
  const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
  const union = b1.width * b1.height + b2.width * b2.height - intersection;
  return union > 0 ? intersection / union : 0;
}

/**
 * Check if b1 is vertically overlapping / riding on b2 (e.g., person on motorcycle)
 */
function isRidingVehicle(personBbox, vehicleBbox) {
  if (!personBbox || !vehicleBbox) return false;
  const personCenterX = personBbox.x + personBbox.width / 2;
  const withinHorizontal = personCenterX >= vehicleBbox.x - 20 &&
                           personCenterX <= vehicleBbox.x + vehicleBbox.width + 20;
  const personBottomY = personBbox.y + personBbox.height;
  const vehicleMidY = vehicleBbox.y + vehicleBbox.height * 0.6;
  const verticalOverlap = personBottomY >= vehicleBbox.y && personBbox.y <= vehicleMidY;
  
  return withinHorizontal && verticalOverlap;
}

/**
 * Vehicle Tracker to estimate velocity between frames
 */
class VehicleSpeedTracker {
  constructor(options = {}) {
    this.history = new Map();
    this.ttlMs = options.ttlMs || 10000;
    this.pixelsPerMeter = options.pixelsPerMeter || PIXELS_PER_METER_DEFAULT;
  }

  track(trackKey, bbox, timestampMs = Date.now()) {
    if (!trackKey || !bbox) return null;
    const centerX = bbox.x + bbox.width / 2;
    const centerY = bbox.y + bbox.height / 2;
    const prev = this.history.get(trackKey);

    let speedKmh = null;
    if (prev && timestampMs > prev.lastTimestamp) {
      const dtSeconds = (timestampMs - prev.lastTimestamp) / 1000;
      if (dtSeconds > 0.05 && dtSeconds < 4.0) {
        const dx = centerX - prev.lastX;
        const dy = centerY - prev.lastY;
        const distPx = Math.sqrt(dx * dx + dy * dy);
        const distMeters = distPx / this.pixelsPerMeter;
        const rawSpeedKmh = (distMeters / dtSeconds) * 3.6;

        if (rawSpeedKmh >= 5 && rawSpeedKmh <= 200) {
          speedKmh = prev.speedKmh ? Math.round(prev.speedKmh * 0.4 + rawSpeedKmh * 0.6) : Math.round(rawSpeedKmh);
        } else if (rawSpeedKmh < 5) {
          speedKmh = 0;
        }
      }
    }

    this.history.set(trackKey, {
      lastX: centerX,
      lastY: centerY,
      lastTimestamp: timestampMs,
      speedKmh: speedKmh ?? prev?.speedKmh ?? null,
    });

    return speedKmh;
  }

  prune(now = Date.now()) {
    for (const [key, entry] of this.history.entries()) {
      if (now - entry.lastTimestamp > this.ttlMs) {
        this.history.delete(key);
      }
    }
  }
}

const globalSpeedTracker = new VehicleSpeedTracker();

/**
 * Main function: Detect violations in an analyzed frame
 *
 * @param {object} frameData
 *   - imageBuffer: Buffer
 *   - vehicle: { detected_vehicle_type, vehicle_bbox, vehicle_confidence }
 *   - occupants: array of { vehicle_type: 'person', vehicle_bbox, vehicle_confidence }
 *   - plate: string (optional)
 *   - speed: number (optional)
 *   - camera: { id, speed_limit_kmh, detect_helmet, detect_seatbelt, detect_speeding }
 *   - telemetry: extra key-value pairs
 * @returns {Promise<object>} { violations: [], flagged: boolean, speedKmh: number, trackingBbox: object }
 */
async function detectViolations(frameData = {}) {
  const violations = [];
  const vehicle = frameData.vehicle || {};
  const vehicleType = (vehicle.detected_vehicle_type || vehicle.vehicle_type || '').toLowerCase();
  const vehicleBbox = vehicle.vehicle_bbox || null;
  const occupants = frameData.occupants || [];
  const camera = frameData.camera || {};
  const telemetry = frameData.telemetry || {};
  const imageBuffer = frameData.imageBuffer || null;
  const timestamp = frameData.timestamp ? new Date(frameData.timestamp).getTime() : Date.now();
  const track = frameData.track || null;

  const speedLimit = Number(camera.speed_limit_kmh) || DEFAULT_SPEED_LIMIT;
  const detectHelmet = camera.detect_helmet !== 0 && camera.detect_helmet !== false;
  const detectSeatbelt = camera.detect_seatbelt !== 0 && camera.detect_seatbelt !== false;
  const detectSpeeding = camera.detect_speeding !== 0 && camera.detect_speeding !== false;

  // 1. SPEED & OVERSPEEDING EVALUATION
  let currentSpeed = frameData.speed !== undefined && frameData.speed !== null
    ? Number(frameData.speed)
    : (telemetry.speed !== undefined ? Number(telemetry.speed) : null);

  // If speed is not given by hardware/telemetry, estimate from tracker
  if (currentSpeed === null && vehicleBbox) {
    const trackKey = frameData.trackId
      ? `${camera.id || 'cam'}:${frameData.trackId}`
      : (frameData.plate
        ? `${camera.id || 'cam'}:${frameData.plate}`
        : `${camera.id || 'cam'}:${vehicleType}`);
    const trackedSpeed = globalSpeedTracker.track(trackKey, vehicleBbox, timestamp);
    if (trackedSpeed !== null) currentSpeed = trackedSpeed;
  }

  // Fast path: if this vehicle track already had violations evaluated, reuse cached neural classifications
  if (track && track.cachedViolations) {
    const cached = track.cachedViolations;
    // Check if speed violation applies on current frame
    const speedViolations = [];
    if (detectSpeeding && currentSpeed !== null && Number.isFinite(currentSpeed)) {
      const overspeedThreshold = speedLimit * 1.25;
      if (currentSpeed > overspeedThreshold) {
        speedViolations.push({
          code: 'overspeeding',
          label: `Overspeeding: ${Math.round(currentSpeed)} km/h (Limit ${speedLimit} km/h)`,
          category: 'speed',
          confidence: 0.95,
          speed: Math.round(currentSpeed),
          speed_limit: speedLimit,
          bbox: vehicleBbox,
        });
      } else if (currentSpeed > speedLimit) {
        speedViolations.push({
          code: 'speeding',
          label: `Speeding: ${Math.round(currentSpeed)} km/h (Limit ${speedLimit} km/h)`,
          category: 'speed',
          confidence: 0.90,
          speed: Math.round(currentSpeed),
          speed_limit: speedLimit,
          bbox: vehicleBbox,
        });
      }
    }

    const mergedViolations = [...cached.violations.filter(v => v.category !== 'speed'), ...speedViolations];
    return {
      violations: mergedViolations,
      flagged: mergedViolations.length > 0,
      violation_type: mergedViolations.map(v => v.label).join(', ') || null,
      speed: currentSpeed !== null ? Math.round(currentSpeed) : cached.speed,
      vehicle_bbox: vehicleBbox || cached.vehicle_bbox,
      speed_limit: speedLimit,
    };
  }

  if (detectSpeeding && currentSpeed !== null && Number.isFinite(currentSpeed)) {
    const overspeedThreshold = speedLimit * 1.25;
    if (currentSpeed > overspeedThreshold) {
      violations.push({
        code: 'overspeeding',
        label: `Overspeeding: ${Math.round(currentSpeed)} km/h (Limit ${speedLimit} km/h)`,
        category: 'speed',
        confidence: 0.95,
        speed: Math.round(currentSpeed),
        speed_limit: speedLimit,
        bbox: vehicleBbox,
      });
    } else if (currentSpeed > speedLimit) {
      violations.push({
        code: 'speeding',
        label: `Speeding: ${Math.round(currentSpeed)} km/h (Limit ${speedLimit} km/h)`,
        category: 'speed',
        confidence: 0.90,
        speed: Math.round(currentSpeed),
        speed_limit: speedLimit,
        bbox: vehicleBbox,
      });
    }
  }

  // 2. HELMET EVALUATION FOR TWO-WHEELERS (Motorcycle, Bicycle)
  const isTwoWheeler = vehicleType === 'motorcycle' || vehicleType === 'bicycle';
  if (detectHelmet && isTwoWheeler && vehicleBbox) {
    if (telemetry.no_helmet || telemetry.helmet_missing || telemetry.helmet === false) {
      violations.push({
        code: 'no_helmet',
        label: 'No helmet detected on rider',
        category: 'helmet',
        confidence: 0.95,
        bbox: vehicleBbox,
      });
    } else if (telemetry.has_helmet || telemetry.helmet === true) {
      // Telemetry explicitly confirms helmet present
    } else if (imageBuffer) {
      // Neural Helmet Detection: run on rider or upper portion of motorcycle
      const rider = occupants.find(occ => isRidingVehicle(occ.vehicle_bbox, vehicleBbox));
      const riderRegion = rider ? rider.vehicle_bbox : vehicleBbox;
      const helmetResult = await helmetDetector.detectHelmet(imageBuffer, riderRegion);
      if (helmetResult.violation) {
        violations.push({
          code: 'no_helmet',
          label: 'No helmet detected on rider',
          category: 'helmet',
          confidence: Math.round(helmetResult.confidence * 100) / 100,
          bbox: helmetResult.detections[0]?.bbox || riderRegion || vehicleBbox,
        });
      }
    }
  }

  // 3. SEATBELT EVALUATION FOR FOUR-WHEELERS (Car, Truck, Bus)
  const isFourWheeler = vehicleType === 'car' || vehicleType === 'truck' || vehicleType === 'bus';
  if (detectSeatbelt && isFourWheeler && vehicleBbox) {
    if (telemetry.no_seatbelt || telemetry.seatbelt_missing || telemetry.seatbelt === false || telemetry.has_seatbelt === false) {
      const cabinBbox = {
        x: Math.round(vehicleBbox.x + vehicleBbox.width * 0.2),
        y: Math.round(vehicleBbox.y + vehicleBbox.height * 0.15),
        width: Math.round(vehicleBbox.width * 0.6),
        height: Math.round(vehicleBbox.height * 0.45),
      };
      violations.push({
        code: 'no_seatbelt',
        label: 'Driver not wearing seatbelt',
        category: 'seatbelt',
        confidence: 0.92,
        bbox: cabinBbox,
      });
    } else if (telemetry.has_seatbelt || telemetry.seatbelt === true) {
      // Telemetry explicitly confirms seatbelt present
    } else if (imageBuffer) {
      // Neural Seatbelt Classification: run on driver / windshield region
      const seatbeltResult = await seatbeltClassifier.classifySeatbelt(imageBuffer, vehicleBbox);
      if (seatbeltResult.violation) {
        violations.push({
          code: 'no_seatbelt',
          label: 'Driver not wearing seatbelt',
          category: 'seatbelt',
          confidence: Math.round(seatbeltResult.confidence * 100) / 100,
          bbox: seatbeltResult.cropBbox || vehicleBbox,
        });
      }
    }
  }

  // 4. MERGE WITH DETECTION INVESTIGATOR (Legacy / Edge AI annotations)
  const externalInvestigate = investigateDetection(telemetry, { imagePath: frameData.imagePath });
  if (externalInvestigate.violations && externalInvestigate.violations.length > 0) {
    for (const v of externalInvestigate.violations) {
      if (!violations.some(existing => existing.code === v.code)) {
        violations.push({
          code: v.code,
          label: v.label,
          category: 'external',
          confidence: 0.9,
          bbox: vehicleBbox,
        });
      }
    }
  }

  const outcome = {
    violations,
    flagged: violations.length > 0,
    violation_type: violations.map(v => v.label).join(', ') || null,
    speed: currentSpeed !== null ? Math.round(currentSpeed) : null,
    vehicle_bbox: vehicleBbox,
    speed_limit: speedLimit,
  };

  if (track) {
    track.cachedViolations = outcome;
    track.violationEvaluated = true;
  }

  return outcome;
}

module.exports = {
  detectViolations,
  VehicleSpeedTracker,
  globalSpeedTracker,
  detectHelmet: helmetDetector.detectHelmet,
  classifySeatbelt: seatbeltClassifier.classifySeatbelt,
  isRidingVehicle,
  bboxIoU,
  DEFAULT_SPEED_LIMIT,
};
