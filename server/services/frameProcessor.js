const crypto = require('crypto');
const sharp = require('sharp');
const { detectVehicles } = require('./vehicleDetector');
const { verifyPlateImage } = require('./plateVerification');
const { detectViolations } = require('./violationDetector');

function numericEnv(name, fallback, minimum = 0) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= minimum ? value : fallback;
}

const DEFAULTS = Object.freeze({
  sampleFps: numericEnv('FRAME_SAMPLE_FPS', numericEnv('ANPR_SAMPLE_FPS', numericEnv('VIDEO_SAMPLE_FPS', 16, 0.1), 0.1), 0.1),
  dedupWindowMs: numericEnv('ANPR_DEDUP_WINDOW_MS', 5000, 0),
  minConfidence: numericEnv('ANPR_MIN_CONFIDENCE', 0, 0),
});

async function resizeFrameForYolo(frameBuffer, maxDim = 640) {
  if (!Buffer.isBuffer(frameBuffer) || frameBuffer.length === 0) return frameBuffer;
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

function normalizePlate(value) {
  return value ? String(value).toUpperCase().replace(/[^A-Z0-9]/g, '') : '';
}

function evidenceScore(result = {}) {
  return Number(result.confidence || result.ocr_confidence || result.finalConfidence || 0)
    + Number(result.plate_confidence || 0) * 0.25
    + (result.plates_agree ? 0.25 : 0);
}

class EvidenceDeduplicator {
  constructor(options = {}) {
    this.windowMs = Number(options.windowMs ?? DEFAULTS.dedupWindowMs);
    this.entries = new Map();
  }

  consider(result, now = Date.now()) {
    const plate = normalizePlate(result.plate);
    if (!plate) return { accepted: false, reason: 'no_plate', result };
    const key = `${result.camera_id || result.source_id || 'source'}:${plate}`;
    const previous = this.entries.get(key);
    const score = evidenceScore(result);
    if (previous && now - previous.seenAt <= this.windowMs) {
      previous.seenAt = now;
      if (score > previous.score) {
        this.entries.set(key, { seenAt: now, score, result });
        return { accepted: true, replacement: true, previous: previous.result, result };
      }
      return { accepted: false, reason: 'duplicate', previous: previous.result, result };
    }
    this.entries.set(key, { seenAt: now, score, result });
    return { accepted: true, replacement: false, result };
  }

  prune(now = Date.now()) {
    for (const [key, entry] of this.entries) {
      if (now - entry.seenAt > this.windowMs) this.entries.delete(key);
    }
  }
}

async function processFrame(imageBuffer, options = {}) {
  if ((!Buffer.isBuffer(imageBuffer) || imageBuffer.length === 0) && typeof imageBuffer !== 'string') {
    const error = new Error('A non-empty frame buffer or image input is required');
    error.code = 'INVALID_FRAME';
    throw error;
  }
  const started = Date.now();
  const activeBuffer = Buffer.isBuffer(imageBuffer)
    ? await resizeFrameForYolo(imageBuffer, 640)
    : imageBuffer;

  const cameraId = options.camera_id || options.cameraId || null;
  const vehicle = await (options.detectVehicles || detectVehicles)(activeBuffer, {
    vendorVehicleType: options.vehicle_type || options.vehicleType || null,
  });
  if (!vehicle.vehicle_detected) {
    return {
      id: `frame-${crypto.randomUUID()}`,
      event_id: options.event_id || `frame-${crypto.randomUUID()}`,
      camera_id: cameraId,
      source_id: options.source_id || cameraId,
      source_type: options.source_type || 'frame_processor',
      timestamp: options.timestamp || new Date().toISOString(),
      vehicle_detected: false,
      detected_vehicle_type: null,
      vehicle_confidence: 0,
      vehicle_bbox: null,
      vehicle_detection_status: vehicle.vehicle_detection_status,
      vehicle_detection_error: vehicle.vehicle_detection_error || null,
      raw: { vehicle },
    };
  }
  let verification = null;
  let detectedVehicleType = vehicle.detected_vehicle_type;
  let detectedVehicleBbox = vehicle.vehicle_bbox;

  // Real-life ANPR: Inspect individual vehicle bounding box crops first
  if (Buffer.isBuffer(activeBuffer) && vehicle.vehicle_detections && vehicle.vehicle_detections.length > 0) {
    try {
      const meta = await sharp(activeBuffer).metadata();
      for (const v of vehicle.vehicle_detections) {
        if (!v.vehicle_bbox || !meta.width || !meta.height) continue;
        const left = Math.max(0, Math.round(v.vehicle_bbox.x));
        const top = Math.max(0, Math.round(v.vehicle_bbox.y));
        const width = Math.min(meta.width - left, Math.round(v.vehicle_bbox.width));
        const height = Math.min(meta.height - top, Math.round(v.vehicle_bbox.height));
        if (width < 30 || height < 20) continue;

        const cropBuf = await sharp(activeBuffer).extract({ left, top, width, height }).jpeg().toBuffer();
        const vVerif = await (options.verifyPlateImage || verifyPlateImage)(cropBuf, {
          vendorPlate: options.plate || null,
        });
        if (vVerif?.plate || vVerif?.detected_plate) {
          if (vVerif.plateRegion) {
            vVerif.plateRegion = {
              x: left + vVerif.plateRegion.x,
              y: top + vVerif.plateRegion.y,
              width: vVerif.plateRegion.width,
              height: vVerif.plateRegion.height,
            };
          }
          if (vVerif.plate_bbox) {
            vVerif.plate_bbox = {
              x: left + vVerif.plate_bbox.x,
              y: top + vVerif.plate_bbox.y,
              width: vVerif.plate_bbox.width,
              height: vVerif.plate_bbox.height,
            };
          }
          verification = vVerif;
          detectedVehicleType = v.vehicle_type || detectedVehicleType;
          detectedVehicleBbox = v.vehicle_bbox;
          break;
        }
      }
    } catch (_) {}
  }

  // Fallback: If no plate was found on vehicle crops, run on the whole frame
  if (!verification || (!verification.plate && !verification.detected_plate)) {
    verification = await (options.verifyPlateImage || verifyPlateImage)(activeBuffer, {
      vendorPlate: options.plate || null,
    });
  }
  const plate = normalizePlate(verification.detected_plate || verification.plate || options.plate);
  const rawConfidence = Number(verification.finalConfidence || verification.plate_confidence || options.confidence || 0);
  const confidence = rawConfidence > 1 ? rawConfidence / 100 : rawConfidence;

  const violation = await (options.detectViolations || detectViolations)({
    imageBuffer: activeBuffer,
    vehicle: {
      detected_vehicle_type: detectedVehicleType,
      vehicle_bbox: detectedVehicleBbox,
      vehicle_confidence: vehicle.vehicle_confidence,
    },
    occupants: vehicle.occupants || [],
    plate: plate || null,
    speed: options.speed,
    camera: { id: cameraId, speed_limit_kmh: options.speed_limit_kmh || 50 },
    telemetry: options.telemetry || {},
  });

  const result = {
    id: `frame-${crypto.randomUUID()}`,
    event_id: options.event_id || `frame-${crypto.randomUUID()}`,
    camera_id: cameraId,
    source_id: options.source_id || cameraId,
    plate: plate || null,
    confidence,
    image_path: options.image_path || null,
    timestamp: options.timestamp || new Date().toISOString(),
    vehicle_type: options.vehicle_type || vehicle.detected_vehicle_type || 'unknown',
    vehicle_color: options.vehicle_color || null,
    vehicle_detected: vehicle.vehicle_detected,
    detected_vehicle_type: vehicle.detected_vehicle_type,
    vehicle_confidence: vehicle.vehicle_confidence || 0,
    vehicle_bbox: vehicle.vehicle_bbox || null,
    vehicle_type_match: vehicle.vehicle_type_match,
    occupants: vehicle.occupants || [],
    ocr_text: verification.rawText || null,
    ocr_confidence: verification.ocrConfidence ?? null,
    ocr_status: verification.success ? 'success' : 'failed',
    source_type: options.source_type || verification.plate_source || 'frame_processor',
    plate_confidence: verification.plate_confidence || 0,
    plate_bbox: verification.plate_bbox || verification.plateRegion || null,
    plate_verification_status: verification.plate_verification_status || null,
    violations: violation.violations || [],
    flagged: violation.flagged ? 1 : 0,
    violation_type: violation.violation_type || null,
    speed: violation.speed ?? null,
    processing_time_ms: Date.now() - started,
  };
  return { ...result, raw: { vehicle, verification, violation } };
}

module.exports = {
  DEFAULTS,
  EvidenceDeduplicator,
  evidenceScore,
  normalizePlate,
  processFrame,
};
