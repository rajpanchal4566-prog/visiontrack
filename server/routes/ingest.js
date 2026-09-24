// ============================================
// VisionTrack — Central Platform Ingestion API
// Validates city-server-authenticated camera events and stores them
// into the existing detections table without creating a parallel store.
// ============================================
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../database');
const { checkWatchlist, updateTrafficStats } = require('../simulator/virtualCamera');
const { validateDetection } = require('../services/travelValidation');
const { investigateDetection } = require('../services/detectionInvestigator');
const { findOcrImageSource } = require('../services/ocrService');
const { verifyPlateImage } = require('../services/plateVerification');
const { normalizeDetection } = require('../services/vendorAdapter');
const { detectVehicles } = require('../services/vehicleDetector');
const { insertDetection } = require('../services/detectionPersistence');

const router = express.Router();

function getCameraToken(req) {
  const authorization = (req.headers.authorization || '').toString().trim();
  const bearerToken = authorization.replace(/^Bearer\s+/i, '');
  return (req.headers['x-camera-token'] || bearerToken || req.body?.api_token || '').toString().trim();
}

function findCamera(db, cameraId, token) {
  if (!cameraId) return null;
  const camera = db.prepare('SELECT * FROM cameras WHERE id = ?').get(cameraId);
  if (!camera || !camera.api_token || camera.api_token !== token) return null;
  return camera;
}

function findLegacyServerCamera(db, cameraId, serverId, serverToken) {
  if (!serverId || !serverToken) return null;
  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId);
  if (!server || server.status !== 'online' || server.api_token !== serverToken) return null;

  const camera = db.prepare('SELECT * FROM cameras WHERE id = ?').get(cameraId);
  if (!camera || camera.server_id !== serverId || camera.organization_id !== server.organization_id) return null;
  return camera;
}

function buildDetectionPayload(raw, camera) {
  const { detection } = normalizeDetection(raw, { camera, saveImages: true });

  return {
    id: `DET-${uuidv4().slice(0, 8)}`,
    event_id: detection.event_id || raw.event_id || `evt-${uuidv4()}`,
    plate: detection.plate,
    camera_id: camera.id,
    location_id: String(detection.location_id || camera.zone || '').trim(),
    timestamp: detection.timestamp,
    confidence: detection.confidence ?? 0,
    vehicle_type: detection.vehicle_type,
    vehicle_color: detection.vehicle_color,
    speed: detection.speed,
    direction: detection.direction,
    image_path: detection.image_path,
    camera,
    // OCR fields — populated later if OCR is triggered
    ocr_text: null,
    ocr_confidence: null,
    ocr_status: null,
    source_type: detection.plate ? 'camera_anpr' : null,
    vendor_vehicle_type: raw.vehicle_type || raw.vehicleType || null,
    detected_vehicle_type: null,
    vehicle_type_match: null,
    vehicle_confidence: 0,
  };
}

router.post('/connect', (req, res) => {
  const db = getDb();
  const cameraId = (req.body?.camera_id || '').toString().trim();
  const camera = findCamera(db, cameraId, getCameraToken(req));

  if (!camera) {
    return res.status(401).json({ error: 'Invalid camera ID or API token' });
  }
  if (camera.status !== 'online') {
    return res.status(403).json({ error: 'Camera is not active' });
  }

  return res.json({
    connected: true,
    camera: { id: camera.id, name: camera.name, location_id: req.body.location_id || camera.zone },
  });
});

router.post('/detection', async (req, res) => {
  const db = getDb();
  const payload = req.body || {};
  const cameraId = (payload.camera_id || '').toString().trim();
  const serverId = (req.headers['x-server-id'] || req.headers['x-server'] || payload.server_id || '').toString().trim();
  const serverHeader = (req.headers['x-server-token'] || payload.server_token || '').toString().trim();
  const serverToken = serverHeader.replace(/^ServerToken\s+/i, '');
  const camera = findCamera(db, cameraId, getCameraToken(req))
    || findLegacyServerCamera(db, cameraId, serverId, serverToken);

  if (!camera) {
    return res.status(401).json({ error: 'Invalid camera ID or API token' });
  }

  if (!cameraId) {
    return res.status(400).json({ error: 'camera_id is required' });
  }

  if (camera.status !== 'online') {
    return res.status(403).json({ error: 'Camera is not active' });
  }

  let detection;
  try {
    detection = buildDetectionPayload(payload, camera);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const vehicleImage = findOcrImageSource(payload) || detection.image_path;
  if (vehicleImage) {
    const vehicleResult = await detectVehicles(vehicleImage, {
      vendorVehicleType: payload.vehicle_type || payload.vehicleType || null,
    });
    Object.assign(detection, vehicleResult);
  }

  // --- Independent plate verification: vendor values are preserved ---
  const imageSource = findOcrImageSource(payload) || detection.image_path;
  let plateVerification = null;
  if (imageSource) {
    try {
      plateVerification = await verifyPlateImage(imageSource, { vendorPlate: detection.plate });
      detection.ocr_text = plateVerification.rawText || null;
      detection.ocr_confidence = plateVerification.ocrConfidence ?? null;
      detection.ocr_status = plateVerification.success ? 'success' : 'failed';
      if (!detection.plate && plateVerification.detected_plate) {
        detection.plate = plateVerification.detected_plate;
        detection.source_type = 'ocr';
        if (!detection.confidence) detection.confidence = plateVerification.ocrConfidence || 0;
      }
    } catch (ocrErr) {
      console.warn('[OCR_FAILED] Ingestion verification error:', ocrErr.message);
      detection.ocr_status = 'failed';
    }
  } else if (detection.plate) {
    detection.ocr_status = 'skipped';
  }

  if (!detection.plate) {
    return res.status(400).json({ error: 'Plate number is required (OCR also failed or no image available)' });
  }

  if (plateVerification) Object.assign(detection, {
    vendor_plate: plateVerification.vendor_plate,
    detected_plate: plateVerification.detected_plate,
    plate_match: plateVerification.plate_match,
    plate_detected: plateVerification.plate_detected,
    plate_confidence: plateVerification.plate_confidence,
    plate_bbox: plateVerification.plate_bbox,
    ocr_raw: plateVerification.rawText,
    ocr_candidates: plateVerification.candidates,
    ocr_final_confidence: plateVerification.finalConfidence,
    plate_verification_status: plateVerification.plate_verification_status,
  });

  const investigation = investigateDetection({ ...payload, violation: payload.violation_tag }, { imagePath: detection.image_path });
  const violations = investigation.violations.map(item => item.label);
  const reportedViolations = [...new Set([
    ...violations,
    ...(payload.violation_reason ? [payload.violation_reason] : []),
  ])];
  detection.violations = JSON.stringify(reportedViolations);
  detection.flagged = investigation.flagged ? 1 : 0;
  detection.violation_type = reportedViolations.join(', ') || null;
  detection.flag_source = investigation.flagged ? 'investigation' : null;
  detection.investigation_status = investigation.status;
  detection.investigation_confidence = investigation.confidence;
  detection.investigation_details = JSON.stringify({
    ...investigation,
    vehicle_verification: {
      vendor_vehicle_type: detection.vendor_vehicle_type,
      detected_vehicle_type: detection.detected_vehicle_type,
      vehicle_type_match: detection.vehicle_type_match,
      vehicle_confidence: detection.vehicle_confidence,
    },
  });

  const inserted = insertDetection(detection);
  if (inserted.duplicate) {
    return res.status(200).json({
      accepted: true,
      duplicate: true,
      detection_id: inserted.id,
      event_id: detection.event_id,
      message: 'Duplicate detection ignored',
    });
  }


  updateTrafficStats(camera.id, detection.vehicle_type);
  if (global.io) {
    const detectionEvent = {
      ...detection,
      camera: {
        id: camera.id,
        name: camera.name,
        city: camera.city,
        lat: camera.lat,
        lng: camera.lng,
        zone: camera.zone,
      },
    };
    if (camera.organization_id) global.io.to(camera.organization_id).emit('detection:new', detectionEvent);
    else global.io.emit('detection:new', detectionEvent);
  }

  const alert = checkWatchlist({ ...detection, camera }, global.io);
  // Validation is deliberately decoupled from ingestion response time. A route
  // service outage must never reject an otherwise valid camera event.
  validateDetection(detection).catch(err => console.warn(`[travel-validation] ${err.message}`));

  res.status(201).json({
    accepted: true,
    duplicate: false,
    detection_id: detection.id,
    event_id: detection.event_id,
    alert: alert ? { id: alert.id, severity: alert.severity } : null,
    source_type: detection.source_type,
    ocr_status: detection.ocr_status,
    vehicle_detection: detection.vehicle_detected === undefined ? null : {
      vehicle_detected: detection.vehicle_detected,
      detected_vehicle_type: detection.detected_vehicle_type,
      vehicle_confidence: detection.vehicle_confidence,
      vehicle_bbox: detection.vehicle_bbox,
      vendor_vehicle_type: detection.vendor_vehicle_type,
      vehicle_type_match: detection.vehicle_type_match,
      status: detection.vehicle_detection_status,
    },
  });
});

module.exports = router;
