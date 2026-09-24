const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const { v4: uuidv4 } = require('uuid');
const router = express.Router();
const { getDb } = require('../database');
const { optionalAuth, getOrgCameraFilter } = require('../middleware/authMiddleware');
const { updateTrafficStats } = require('../simulator/virtualCamera');
const { validateDetection } = require('../services/travelValidation');
const { investigateDetection } = require('../services/detectionInvestigator');
const { normalizeDetection: vendorNormalize } = require('../services/vendorAdapter');
const { findOcrImageSource } = require('../services/ocrService');
const { verifyPlateImage } = require('../services/plateVerification');
const { detectVehicles } = require('../services/vehicleDetector');

const cameraImageLimitBytes = Number(process.env.CAMERA_IMAGE_LIMIT_BYTES) || 50 * 1024 * 1024;

function normalizedPlateSql(column) {
  return `REPLACE(REPLACE(UPPER(${column}), '-', ''), ' ', '')`;
}

const multipartParser = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: cameraImageLimitBytes, files: 1 },
}).single('image');

function parseIngestBody(body) {
  const raw = body && typeof body === 'object' ? body : {};
  if (typeof raw.fields !== 'string') return raw;

  let fields;
  try {
    fields = JSON.parse(raw.fields);
  } catch (error) {
    throw new Error('The multipart fields value must contain valid JSON');
  }
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    throw new Error('The multipart fields value must contain a JSON object');
  }
  const { fields: ignored, ...formFields } = raw;
  return { ...fields, ...formFields };
}

// Public universal device endpoint. It intentionally appears before optional
// JWT auth so hardware can submit with only its organization API key.
router.post('/ingest', multipartParser, async (req, res) => {
  const db = getDb();
  let input;
  try {
    input = parseIngestBody(req.body);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length === 0) {
    return res.status(400).json({ error: 'Detection payload must be a non-empty JSON object' });
  }

  const { detection: normalized } = vendorNormalize(input, {
    uploadedFile: req.file,
    saveImages: true,
  });

  const vehicleImage = findOcrImageSource(input) || normalized.image_path;
  if (vehicleImage) {
    const vehicleResult = await detectVehicles(vehicleImage, {
      vendorVehicleType: input.vehicle_type || input.vehicleType || null,
    });
    Object.assign(normalized, vehicleResult);
  }

  if (!normalized.camera_id) {
    return res.status(400).json({ error: 'camera_id is required' });
  }

  // --- Independent plate verification: vendor values are preserved ---
  let ocrText = null;
  let ocrConfidence = null;
  let ocrStatus = null;
  let sourceType = 'camera_anpr';
  const imageSource = findOcrImageSource(input) || normalized.image_path;
  let plateVerification = null;
  if (imageSource) {
    try {
      plateVerification = await verifyPlateImage(imageSource, { vendorPlate: normalized.plate });
      ocrText = plateVerification.rawText || null;
      ocrConfidence = plateVerification.ocrConfidence ?? null;
      ocrStatus = plateVerification.success ? 'success' : 'failed';
      if (!normalized.plate && plateVerification.detected_plate) {
        normalized.plate = plateVerification.detected_plate;
        sourceType = 'ocr';
        if (!normalized.confidence) normalized.confidence = plateVerification.ocrConfidence || 0;
      }
    } catch (ocrErr) {
      console.warn('[OCR_FAILED] Detections verification error:', ocrErr.message);
      ocrStatus = 'failed';
    }
  } else if (normalized.plate) {
    ocrStatus = 'skipped';
  }

  if (!normalized.plate) {
    return res.status(400).json({ error: 'plate is required (OCR also failed or no image available)' });
  }

  const apiKey = String(req.headers['x-api-key'] || '').trim();
  const cameraId = String(normalized.camera_id || input.camera_id || input.cameraId || '').trim();
  const camera = db.prepare('SELECT * FROM cameras WHERE id = ?').get(cameraId);
  if (!camera) return res.status(404).json({ error: 'Camera not found' });

  const organization = camera.organization_id
    ? db.prepare('SELECT api_key, name, id as organization_id FROM organizations WHERE id = ?').get(camera.organization_id)
    : null;
  if (organization && organization.api_key !== apiKey) {
    return res.status(401).json({ error: 'Invalid or missing X-API-Key' });
  }
  if (camera.status !== 'online') return res.status(403).json({ error: 'Camera is not active' });

  const eventId = String(input.event_id || input.eventId || input.id || `evt-${uuidv4()}`);
  const existing = db.prepare('SELECT id FROM detections WHERE event_id = ?').get(eventId);
  if (existing) return res.status(409).json({ error: 'Duplicate event_id', event_id: eventId, detection_id: existing.id });

  const watchlistEntry = db.prepare(
    `SELECT * FROM watchlist WHERE ${normalizedPlateSql('plate')} = ? AND is_active = 1 AND list_type = 'blacklist'`
  ).get(normalized.plate.replace(/[^a-z0-9]/gi, '').toUpperCase());
  const flagged = normalized.hardware_flagged || Boolean(watchlistEntry);
  const flagSource = normalized.hardware_flagged ? 'hardware_violation' : watchlistEntry ? 'watchlist' : null;
  const investigation = investigateDetection(input, { imagePath: normalized.image_path });
  const investigationLabels = investigation.violations.map(item => item.label);
  const violationLabels = [...new Set([
    ...investigationLabels,
    normalized.violation_type,
    normalized.violation_reason,
    watchlistEntry?.reason,
  ].filter(Boolean))];
  const violationType = violationLabels.join(', ') || null;
  const isFlagged = flagged || investigation.flagged;
  const source = investigation.flagged ? 'investigation' : flagSource;

  const detection = {
    id: `DET-${uuidv4().slice(0, 8)}`,
    event_id: eventId,
    camera_id: camera.id,
    location_id: input.location_id || input.locationId || input.location_tag || camera.zone,
    plate: normalized.plate,
    timestamp: normalized.timestamp,
    confidence: normalized.confidence ?? 0,
    vehicle_type: normalized.vehicle_type || 'unknown',
    vehicle_color: normalized.vehicle_color || null,
    vehicle_make: input.vehicle_make || input.vehicleMake || null,
    speed: normalized.speed,
    direction: input.direction || input.heading || null,
    violations: JSON.stringify(violationLabels),
    image_path: normalized.image_path,
    flagged: isFlagged ? 1 : 0,
    violation_type: violationType,
    flag_source: source,
    investigation_status: investigation.status,
    investigation_confidence: investigation.confidence,
    investigation_details: JSON.stringify({
      ...investigation,
      vehicle_verification: {
      vendor_vehicle_type: normalized.vendor_vehicle_type || input.vehicle_type || input.vehicleType || null,
      detected_vehicle_type: normalized.detected_vehicle_type || null,
      vehicle_type_match: normalized.vehicle_type_match ?? null,
      vehicle_confidence: normalized.vehicle_confidence ?? 0,
      },
    }),
    ocr_text: ocrText,
    ocr_confidence: ocrConfidence,
    ocr_status: ocrStatus,
    source_type: sourceType,
    vendor_vehicle_type: normalized.vendor_vehicle_type || input.vehicle_type || input.vehicleType || null,
    detected_vehicle_type: normalized.detected_vehicle_type || null,
    vehicle_type_match: normalized.vehicle_type_match ?? null,
    vehicle_confidence: normalized.vehicle_confidence ?? 0,
    ...(plateVerification ? {
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
    } : {}),
  };

  db.prepare(`
    INSERT INTO detections (id, event_id, plate, camera_id, location_id, timestamp, confidence, vehicle_type, vehicle_color, vehicle_make, speed, direction, violations, image_path, flagged, violation_type, flag_source, investigation_status, investigation_confidence, investigation_details, ocr_text, ocr_confidence, ocr_status, source_type)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    detection.id, detection.event_id, detection.plate, detection.camera_id, detection.location_id,
    detection.timestamp, detection.confidence, detection.vehicle_type, detection.vehicle_color,
    detection.vehicle_make, detection.speed, detection.direction, detection.violations, detection.image_path,
    detection.flagged, detection.violation_type, detection.flag_source,
    detection.investigation_status, detection.investigation_confidence, detection.investigation_details,
    detection.ocr_text, detection.ocr_confidence, detection.ocr_status, detection.source_type,
  );

  updateTrafficStats(camera.id, detection.vehicle_type);
  let alert = null;
  if (isFlagged) {
    alert = {
      id: `ALT-${uuidv4().slice(0, 8)}`,
      detection_id: detection.id,
      plate: detection.plate,
      camera_id: camera.id,
      timestamp: detection.timestamp,
      type: violationType || 'FLAGGED DETECTION',
      severity: 'critical',
      status: 'active',
      source,
      image_path: detection.image_path,
      vehicle_type: detection.vehicle_type,
      vehicle_color: detection.vehicle_color,
      confidence: detection.confidence,
      description: `${violationType || 'Flagged detection'} for ${detection.plate} at ${camera.name}`,
    };
    db.prepare(`
      INSERT INTO alerts (id, detection_id, plate, camera_id, timestamp, type, severity, status, description, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(alert.id, alert.detection_id, alert.plate, alert.camera_id, alert.timestamp,
      alert.type, alert.severity, alert.status, alert.description, alert.source);
  }
  validateDetection(detection).catch(err => console.warn(`[travel-validation] ${err.message}`));
  const emittedDetection = {
    ...detection,
    camera: { id: camera.id, name: camera.name, city: camera.city, lat: camera.lat, lng: camera.lng, zone: camera.zone },
  };
  const cameraForEvent = emittedDetection.camera;
  if (organization?.name) cameraForEvent.organization_name = organization.name;
  const io = req.app.get('io');
  if (organization?.organization_id) {
    io.to(camera.organization_id).emit('detection:new', emittedDetection);
  } else {
    io.emit('detection:new', emittedDetection);
  }
  if (alert) {
    const event = { ...alert, camera: cameraForEvent };
    if (organization?.organization_id) {
      io.to(camera.organization_id).emit('alert:new', event);
    } else {
      io.emit('alert:new', event);
    }
    const parentOrganization = camera.organization_id
      ? db.prepare('SELECT parent_organization_id FROM organizations WHERE id = ?').get(camera.organization_id)
      : null;
    if (parentOrganization?.parent_organization_id) {
      io.to(parentOrganization.parent_organization_id).emit('alert:new', event);
    }
  }

  return res.status(201).json({
    success: true,
    accepted: true,
    detection: emittedDetection,
    flagged: isFlagged,
    alert,
    source_type: sourceType,
    ocr_status: ocrStatus,
  });
});

// Apply optional auth to all dashboard detection routes.
router.use(optionalAuth);

// GET /api/detections/flagged — Hardware and watchlist flagged detections.
router.get('/flagged', (req, res) => {
  const db = getDb();
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
  const params = [];
  let query = `
    SELECT d.*, c.name as camera_name, c.city as camera_city, c.zone as camera_zone,
      c.lat as camera_lat, c.lng as camera_lng, c.organization_id,
      o.name as organization_name
    FROM detections d
    JOIN cameras c ON c.id = d.camera_id
    LEFT JOIN organizations o ON o.id = c.organization_id
    WHERE d.flagged = 1
  `;
  const orgId = getOrgCameraFilter(req);
  if (orgId) {
    query += ' AND c.organization_id IN (SELECT id FROM organizations WHERE id = ? OR parent_organization_id = ?)';
    params.push(orgId, orgId);
  }
  if (['hardware_violation', 'watchlist', 'investigation'].includes(req.query.source)) {
    query += ' AND d.flag_source = ?';
    params.push(req.query.source);
  }
  query += ' ORDER BY d.timestamp DESC LIMIT ?';
  params.push(limit);
  res.json(db.prepare(query).all(...params));
});

// Helper: build org-scoped camera filter subquery
function orgCameraClause(orgId, params) {
  if (!orgId) return '';
  params.push(orgId);
  return ' AND d.camera_id IN (SELECT id FROM cameras WHERE organization_id = ?)';
}

function getDetectionById(db, id) {
  const detection = db.prepare(`
    SELECT d.*, c.name as camera_name, c.city as camera_city, c.zone as camera_zone,
      c.lat as camera_lat, c.lng as camera_lng, c.organization_id,
      o.name as organization_name
    FROM detections d
    JOIN cameras c ON c.id = d.camera_id
    LEFT JOIN organizations o ON o.id = c.organization_id
    WHERE d.id = ?
  `).get(id);
  if (!detection) return null;
  try {
    const verification = JSON.parse(detection.investigation_details || '{}').vehicle_verification;
    if (verification) Object.assign(detection, verification);
  } catch {
    // Legacy investigation details may not contain verification metadata.
  }
  return detection;
}

async function loadDetectionImage(imagePath) {
  if (!imagePath || typeof imagePath !== 'string') return null;
  if (imagePath.startsWith('data:image/')) {
    const encoded = imagePath.split(',')[1];
    return encoded ? Buffer.from(encoded, 'base64') : null;
  }

  if (/^https?:\/\//i.test(imagePath)) {
    const response = await fetch(imagePath);
    if (!response.ok) return null;
    return Buffer.from(await response.arrayBuffer());
  }

  const relativePath = imagePath.replace(/^\/+/, '');
  const candidates = [
    path.join(__dirname, '..', relativePath),
    path.join(__dirname, '..', '..', relativePath),
  ];
  const localPath = candidates.find(candidate => fs.existsSync(candidate));
  return localPath ? fs.readFileSync(localPath) : null;
}

function drawReportTable(doc, rows, x, y, width) {
  const labelWidth = 155;
  const rowHeight = 22;
  rows.forEach(([label, value], index) => {
    const rowY = y + index * rowHeight;
    doc.rect(x, rowY, width, rowHeight).fillAndStroke(index % 2 ? '#f4f7fa' : '#ffffff', '#d8e0e8');
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#344054').text(label, x + 8, rowY + 7, { width: labelWidth - 16 });
    doc.font('Helvetica').fillColor('#101828').text(String(value ?? 'Not available'), x + labelWidth, rowY + 7, { width: width - labelWidth - 12 });
  });
}

function formatConfidence(value) {
  const confidence = Number(value);
  if (!Number.isFinite(confidence)) return 'Not available';
  return `${(confidence <= 1 ? confidence * 100 : confidence).toFixed(1)}%`;
}

// GET /api/detections/:id/report — Download a styled report for one detection.
router.get('/:id/report', async (req, res) => {
  const db = getDb();
  const detection = getDetectionById(db, req.params.id);
  if (!detection) return res.status(404).json({ error: 'Detection not found' });

  let image = null;
  try {
    image = await loadDetectionImage(detection.image_path);
  } catch (error) {
    console.warn(`[detection-report] image unavailable: ${error.message}`);
  }

  const doc = new PDFDocument({ size: 'A4', margin: 42 });
  const fileName = `detection-${detection.id}-report.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  doc.pipe(res);

  doc.rect(0, 0, doc.page.width, 92).fill('#12263a');
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(22).text('VisionTrack Detection Report', 42, 30);
  doc.font('Helvetica').fontSize(9).text(`Report ID: ${detection.id}`, 42, 61);
  doc.text(`Generated: ${new Date().toLocaleString()}`, 350, 61, { width: 200, align: 'right' });
  doc.fillColor('#101828').font('Helvetica-Bold').fontSize(13).text('Detection Snapshot', 42, 118);

  let tableY = 142;
  if (image) {
    try {
      doc.image(image, 42, 142, { fit: [205, 145], align: 'center', valign: 'center' });
      tableY = 306;
    } catch (error) {
      console.warn(`[detection-report] unsupported image: ${error.message}`);
    }
  } else {
    doc.roundedRect(42, 142, 205, 145, 4).fillAndStroke('#f4f7fa', '#d8e0e8');
    doc.fillColor('#667085').font('Helvetica').fontSize(10).text('No snapshot available', 42, 210, { width: 205, align: 'center' });
    tableY = 306;
  }

  const rows = [
    ['License Plate', detection.plate],
    ['Camera ID', detection.camera_id],
    ['Camera Name', detection.camera_name],
    ['Location / Zone', detection.camera_zone || detection.location_id],
    ['City', detection.camera_city],
    ['Timestamp', new Date(detection.timestamp).toLocaleString()],
    ['Confidence', formatConfidence(detection.confidence)],
    ['Vehicle Type', detection.vehicle_type],
    ['Vehicle Color', detection.vehicle_color],
    ['Speed', detection.speed == null ? 'Not available' : `${detection.speed} km/h`],
    ['Flagged', detection.flagged ? 'Yes' : 'No'],
    ['Violation / Flag Reason', detection.flagged ? (detection.violation_type || 'Flagged detection') : 'Not applicable'],
    ['Flag Source', detection.flagged ? (detection.flag_source || 'Not available') : 'Not applicable'],
  ];
  doc.fillColor('#101828').font('Helvetica-Bold').fontSize(13).text('Detection Metadata', 42, tableY);
  drawReportTable(doc, rows, 42, tableY + 24, 511);
  doc.font('Helvetica').fontSize(9).fillColor('#667085').text(
    detection.organization_name || 'Organization not assigned',
    42, 760, { width: 511, align: 'center' },
  );
  doc.end();
});

// GET /api/detections/:id — Complete detection with camera and organization data.
router.get('/:id', (req, res, next) => {
  if (req.params.id === 'latest' || req.params.id === 'stats') return next();
  const detection = getDetectionById(getDb(), req.params.id);
  if (!detection) return res.status(404).json({ error: 'Detection not found' });
  res.json(detection);
});

// GET /api/detections — List detections with filters
router.get('/', (req, res) => {
  const db = getDb();
  const { camera, plate, limit = 50, offset = 0 } = req.query;
  const orgId = getOrgCameraFilter(req);

  let query = `
    SELECT d.*, c.name as camera_name, c.city as camera_city, c.lat as camera_lat, c.lng as camera_lng, c.zone as camera_zone
    FROM detections d 
    JOIN cameras c ON d.camera_id = c.id 
    WHERE 1=1
  `;
  const params = [];

  if (orgId) { query += ' AND c.organization_id = ?'; params.push(orgId); }
  if (camera) { query += ' AND d.camera_id = ?'; params.push(camera); }
  if (plate) { query += ' AND d.plate LIKE ?'; params.push(`%${plate}%`); }

  query += ' ORDER BY d.timestamp DESC LIMIT ? OFFSET ?';
  params.push(parseInt(limit), parseInt(offset));

  const detections = db.prepare(query).all(...params);

  let countQuery = 'SELECT COUNT(*) as count FROM detections d';
  const countParams = [];
  if (orgId) {
    countQuery += ' JOIN cameras c ON d.camera_id = c.id WHERE c.organization_id = ?';
    countParams.push(orgId);
  }
  const total = db.prepare(countQuery).get(...countParams).count;
  res.json({ detections, total });
});

// GET /api/detections/latest — Latest N detections
router.get('/latest', (req, res) => {
  const db = getDb();
  const limit = parseInt(req.query.limit) || 20;
  const orgId = getOrgCameraFilter(req);

  let query = `
    SELECT d.*, c.name as camera_name, c.city as camera_city, c.lat as camera_lat, c.lng as camera_lng, c.zone as camera_zone
    FROM detections d 
    JOIN cameras c ON d.camera_id = c.id 
  `;
  const params = [];
  if (orgId) { query += ' WHERE c.organization_id = ?'; params.push(orgId); }
  query += ' ORDER BY d.timestamp DESC LIMIT ?';
  params.push(limit);

  const detections = db.prepare(query).all(...params);
  res.json(detections);
});

// GET /api/detections/stats — Detection statistics for today
router.get('/stats', (req, res) => {
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);
  const orgId = getOrgCameraFilter(req);

  let whereClause = "WHERE date(d.timestamp) = ?";
  let joinClause = '';
  const baseParams = [today];

  if (orgId) {
    joinClause = ' JOIN cameras c ON d.camera_id = c.id';
    whereClause += ' AND c.organization_id = ?';
    baseParams.push(orgId);
  }

  const totalToday = db.prepare(
    `SELECT COUNT(*) as count FROM detections d${joinClause} ${whereClause}`
  ).get(...baseParams).count;

  const uniqueVehiclesToday = db.prepare(
    `SELECT COUNT(DISTINCT d.plate) as count FROM detections d${joinClause} ${whereClause}`
  ).get(...baseParams).count;

  const totalAllTime = db.prepare(
    `SELECT COUNT(*) as count FROM detections d${joinClause} ${orgId ? 'WHERE c.organization_id = ?' : ''}`
  ).get(...(orgId ? [orgId] : [])).count;

  const uniqueVehiclesAllTime = db.prepare(
    `SELECT COUNT(DISTINCT d.plate) as count FROM detections d${joinClause} ${orgId ? 'WHERE c.organization_id = ?' : ''}`
  ).get(...(orgId ? [orgId] : [])).count;

  const avgConfidence = db.prepare(
    `SELECT AVG(CASE WHEN d.confidence > 1 THEN d.confidence / 100.0 ELSE d.confidence END) as avg FROM detections d${joinClause} ${whereClause}`
  ).get(...baseParams).avg || 0;

  const byType = db.prepare(`
    SELECT d.vehicle_type, COUNT(*) as count 
    FROM detections d${joinClause} ${whereClause}
    GROUP BY d.vehicle_type ORDER BY count DESC
  `).all(...baseParams);

  res.json({
    totalToday,
    uniqueVehiclesToday,
    totalAllTime,
    uniqueVehiclesAllTime,
    avgConfidence,
    byType,
  });
});

module.exports = router;
