// ============================================
// VisionTrack — Unified Vendor Adapter
//
// Single authoritative module that owns ALL detection
// field-normalization logic. Replaces the previously
// duplicated implementations in:
//   - routes/ingest.js   (buildDetectionPayload)
//   - routes/decode.js   (decodePayload)
//   - services/detectionNormalizer.js (normalizeDetection)
//   - utils/normalizeDetection.js (normalizeIncomingDetection)
// ============================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DETECTION_UPLOAD_DIR = path.join(__dirname, '..', 'uploads', 'detections');

// ──────────────────────────────────────────────
// Vendor Profiles — exact, tested field mappings
// for known camera brands. "detect" determines if
// a payload matches the profile; "fields" maps
// canonical field names to vendor-specific keys.
// ──────────────────────────────────────────────
const VENDOR_PROFILES = {
  hikvision: {
    detect: (raw) => !!(raw?.EventNotificationAlert || raw?.trafficData || raw?.plateConfidence !== undefined),
    fields: {
      plate: ['licensePlate', 'plateNumber', 'plate_number'],
      confidence: ['plateConfidence', 'confidence', 'score'],
      vehicle_type: ['vehicleType', 'vehicle_type'],
      vehicle_color: ['vehicleColor', 'vehicle_color'],
      image: ['pictureData', 'imageData', 'image', 'snapshot'],
      camera_id: ['deviceId', 'camera_id', 'cameraId'],
      camera_name: ['deviceName', 'camera_name'],
      timestamp: ['captureTime', 'dateTime', 'timestamp'],
      event_id: ['eventId', 'event_id', 'id'],
      speed: ['speed', 'vehicle_speed'],
      direction: ['direction', 'travelDirection'],
      location_id: ['locationId', 'location_id', 'zone'],
    },
  },
  dahua: {
    detect: (raw) => !!(raw?.TrafficEvent || raw?.method === 'trafficSnap' || raw?.TrafficSnapInfo),
    fields: {
      plate: ['PlateNumber', 'plateNumber', 'plate_number'],
      confidence: ['Confidence', 'confidence'],
      vehicle_type: ['VehicleType', 'vehicleType'],
      vehicle_color: ['VehicleColor', 'vehicleColor'],
      image: ['Image', 'PictureInfo', 'image'],
      camera_id: ['DeviceID', 'SerialNo', 'camera_id'],
      camera_name: ['DeviceName', 'camera_name'],
      timestamp: ['EventTime', 'UTCTime', 'timestamp'],
      event_id: ['EventID', 'event_id', 'id'],
      speed: ['Speed', 'speed'],
      direction: ['Direction', 'direction'],
      location_id: ['Lane', 'location_id', 'zone'],
    },
  },
};

// ──────────────────────────────────────────────
// Superset field-alias registry — union of all
// four previous implementations
// ──────────────────────────────────────────────
const FIELD_ALIASES = {
  plate: [
    'plate_number', 'plate', 'plateNumber', 'license_plate', 'licensePlate',
    'number_plate', 'numberPlate', 'reg_number', 'registration',
    'vehicle.plate', 'vehicle.plate_number', 'result.plate',
    'anpr.plate', 'data.plate', 'vehicle.licensePlate', 'vehicle.license_plate',
    'device.plate', 'vehicle.plateNumber', 'capture.plate', 'recognition.plate',
    'camera.plate', 'vehicle.registration', 'vehicle.numberPlate',
  ],
  confidence: [
    'confidence', 'score', 'accuracy', 'recognition_confidence',
    'plateConfidence', 'probability', 'ocr_confidence', 'ocrConfidence',
    'result.confidence', 'anpr.confidence', 'recognition.confidence', 'vehicle.confidence',
    'capture.confidence', 'device.confidence',
  ],
  vehicle_type: [
    'vehicle_type', 'vehicleType', 'type', 'vehicle.type',
    'vehicle_class', 'vehicleClass', 'category', 'vehicle.category',
    'recognition.type', 'capture.type', 'vehicle.model',
  ],
  vehicle_color: [
    'vehicle_color', 'vehicleColor', 'color', 'vehicle.color',
    'colour', 'vehicle_colour', 'vehicle.colour', 'recognition.color',
    'capture.color',
  ],
  vehicle_make: [
    'vehicle_make', 'vehicleMake', 'make', 'manufacturer', 'brand', 'vehicle.make',
    'vehicle.brand',
  ],
  speed: [
    'speed', 'speed_kmh', 'speedKmh', 'vehicle_speed',
    'vehicle.speed', 'speed_km_h', 'detected_speed', 'vehicle.speed_kmh',
    'recognition.speed', 'capture.speed', 'result.speed',
  ],
  direction: [
    'direction', 'travel_direction', 'travelDirection',
    'heading', 'lane_direction', 'vehicle.direction', 'capture.direction',
  ],
  camera_id: [
    'camera_id', 'cameraId', 'camera', 'device_id',
    'deviceId', 'source_id', 'sourceId', 'sensor_id',
    'device.id', 'camera.id', 'device.deviceId', 'device.cameraId', 'source.id',
  ],
  camera_name: [
    'camera_name', 'cameraName', 'device_name', 'deviceName',
    'source_name', 'location_name', 'device.name', 'camera.name', 'source.name',
  ],
  timestamp: [
    'timestamp', 'time', 'datetime', 'date_time',
    'capture_time', 'captureTime', 'event_time', 'eventTime',
    'created_at', 'createdAt', 'detected_at', 'detectedAt',
    'device.timestamp', 'event.timestamp', 'capture.timestamp', 'vehicle.timestamp',
  ],
  event_id: [
    'event_id', 'eventId', 'id', 'detection_id',
    'transaction_id', 'transactionId', 'result.id', 'event.id', 'capture.id',
  ],
  location_id: [
    'location_id', 'locationId', 'zone', 'area',
    'location', 'site_id', 'siteId', 'location_tag', 'device.zone', 'camera.zone',
  ],
  image: [
    'image_base64', 'imageBase64', 'image', 'snapshot',
    'plate_image', 'plateImage', 'picture', 'pictureData',
    'imageData', 'snapshotData', 'vehicleImage', 'plateImageBase64',
    'image_url', 'imageUrl', 'snapshot_url', 'snapshotUrl', 'picture_url',
    'pictureUrl', 'photo_url', 'photoUrl', 'vehicle_image_url', 'plate_image_url',
    'image_path', 'frame_snapshot_path', 'vehicle.image', 'capture.image',
    'recognition.image', 'device.image', 'result.image',
  ],
  violations: [
    'violations', 'violation', 'violation_type', 'violationType',
    'offense', 'offence', 'offences', 'infractions',
    'traffic_violations', 'alerts', 'event_type', 'eventType',
    'alert_type', 'alertType', 'violation_tag',
  ],
};

// Regex pattern fallbacks — used only when alias lists fail
const PATTERN_FALLBACKS = {
  plate: [/plate/, /license.*number/, /registration.*number/, /reg.*number/],
  image: [/image/, /snapshot/, /picture/, /photo/, /vehiclepic/, /platepic/],
  confidence: [/confid/, /score/, /accura/],
  speed: [/speed/],
};

// Vehicle type normalization map
const VEHICLE_TYPE_MAP = {
  car: 'Sedan', sedan: 'Sedan', suv: 'SUV', truck: 'Truck',
  bus: 'Bus', bike: 'Bike', motorcycle: 'Bike', auto: 'Auto', van: 'Van',
};

// ──────────────────────────────────────────────
// Field Resolution Engine
// ──────────────────────────────────────────────

/**
 * Normalize a key for case-insensitive comparison.
 */
function normalizeKey(key) {
  return String(key).replace(/[^a-z0-9]/gi, '').toLowerCase();
}

/**
 * Check if a value is non-empty.
 */
function isPresent(value) {
  return value !== undefined && value !== null && value !== '';
}

/**
 * Try to resolve a value from an object via exact keys (case-insensitive).
 * Returns { value, path } or null.
 */
function resolveByExactKey(obj, keys) {
  for (const key of keys) {
    if (!key.includes('.')) {
      // Direct lookup — case-insensitive
      const found = Object.keys(obj).find(k => k.toLowerCase() === key.toLowerCase());
      if (found !== undefined && isPresent(obj[found])) {
        return { value: obj[found], path: `exact_key:${found}` };
      }
    }
  }
  return null;
}

/**
 * Try to resolve a value via dot-notation paths (e.g. "vehicle.plate").
 * Returns { value, path } or null.
 */
function resolveByDotPath(obj, keys) {
  for (const key of keys) {
    if (!key.includes('.')) continue;
    const parts = key.split('.');
    let val = obj;
    for (const p of parts) {
      if (val == null || typeof val !== 'object') { val = undefined; break; }
      const found = Object.keys(val).find(k => k.toLowerCase() === p.toLowerCase());
      val = found !== undefined ? val[found] : undefined;
    }
    if (isPresent(val)) {
      return { value: val, path: `dot_path:${key}` };
    }
  }
  return null;
}

/**
 * Recursively search nested objects for any matching key.
 * Returns { value, path } or null.
 */
function resolveByNestedSearch(obj, keys, visited = new Set()) {
  if (!obj || typeof obj !== 'object' || visited.has(obj)) return null;
  visited.add(obj);

  const wanted = new Set(keys.map(normalizeKey));
  for (const [key, value] of Object.entries(obj)) {
    if (wanted.has(normalizeKey(key)) && isPresent(value)) {
      return { value, path: `nested_search:${key}` };
    }
  }

  for (const value of Object.values(obj)) {
    const found = resolveByNestedSearch(value, keys, visited);
    if (found !== null) return found;
  }
  return null;
}

/**
 * Regex pattern fallback — recursively searches for keys matching patterns.
 * Returns { value, path } or null.
 */
function resolveByPattern(obj, patterns, visited = new Set()) {
  if (!patterns || patterns.length === 0) return null;
  if (!obj || typeof obj !== 'object' || visited.has(obj)) return null;
  visited.add(obj);

  for (const [key, value] of Object.entries(obj)) {
    if (patterns.some(p => p.test(normalizeKey(key))) && isPresent(value)) {
      return { value, path: `pattern_match:${key}` };
    }
  }
  for (const value of Object.values(obj)) {
    const found = resolveByPattern(value, patterns, visited);
    if (found !== null) return found;
  }
  return null;
}

/**
 * Master field resolver. Tries strategies in order:
 *   1. vendor_profile (if matched)
 *   2. exact_key
 *   3. dot_path
 *   4. nested_search
 *   5. pattern_match
 *
 * @param {object} obj - Raw payload
 * @param {string} fieldName - Canonical field name (e.g. 'plate')
 * @param {object|null} vendorProfile - Matched vendor profile or null
 * @param {string|null} vendorName - Vendor name or null
 * @returns {{ value: any, path: string } | null}
 */
function resolveField(obj, fieldName, vendorProfile, vendorName) {
  // Strategy 1: Vendor profile exact mapping
  if (vendorProfile && vendorProfile.fields[fieldName]) {
    const vendorKeys = vendorProfile.fields[fieldName];
    const keysArr = Array.isArray(vendorKeys) ? vendorKeys : [vendorKeys];
    for (const key of keysArr) {
      if (!key.includes('.')) {
        const found = Object.keys(obj).find(k => k.toLowerCase() === key.toLowerCase());
        if (found !== undefined && isPresent(obj[found])) {
          return { value: obj[found], path: `vendor_profile:${vendorName}:${found}` };
        }
      }
    }
    // Vendor profile may also use dot paths
    const dotResult = resolveByDotPath(obj, keysArr);
    if (dotResult) {
      return { value: dotResult.value, path: `vendor_profile:${vendorName}:${dotResult.path}` };
    }
  }

  const aliases = FIELD_ALIASES[fieldName];
  if (!aliases) return null;

  // Strategy 2: Exact key
  const exact = resolveByExactKey(obj, aliases);
  if (exact) return exact;

  // Strategy 3: Dot path
  const dotPath = resolveByDotPath(obj, aliases);
  if (dotPath) return dotPath;

  // Strategy 4: Nested search
  const nested = resolveByNestedSearch(obj, aliases);
  if (nested) return nested;

  // Strategy 5: Regex pattern fallback
  const patterns = PATTERN_FALLBACKS[fieldName];
  if (patterns) {
    const pattern = resolveByPattern(obj, patterns);
    if (pattern) return pattern;
  }

  return null;
}

// ──────────────────────────────────────────────
// Image Normalization
// ──────────────────────────────────────────────

function extensionForMime(mimeType) {
  const mime = String(mimeType || '').toLowerCase();
  return { 'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/png': '.png',
           'image/webp': '.webp', 'image/gif': '.gif', 'image/bmp': '.bmp' }[mime] || '.jpg';
}

function saveImageBuffer(buffer, extension) {
  fs.mkdirSync(DETECTION_UPLOAD_DIR, { recursive: true });
  const filename = `${crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex')}${extension}`;
  fs.writeFileSync(path.join(DETECTION_UPLOAD_DIR, filename), buffer);
  return `/uploads/detections/${filename}`;
}

function saveUploadedFile(uploadedFile) {
  if (!uploadedFile?.buffer || !Buffer.isBuffer(uploadedFile.buffer)) return null;
  return saveImageBuffer(uploadedFile.buffer, extensionForMime(uploadedFile.mimetype));
}

function saveBase64Image(value) {
  const input = String(value).trim();
  const dataUri = input.match(/^data:(image\/[^;]+);base64,([a-z0-9+/\s]+=*)$/i);
  const encoded = dataUri ? dataUri[2] : input;
  const isLongBase64 = encoded.length >= 100 && /^[a-z0-9+/\s]+=*$/i.test(encoded);
  if (!dataUri && !isLongBase64) return null;

  const extension = dataUri ? extensionForMime(dataUri[1]) : '.jpg';
  try {
    return saveImageBuffer(Buffer.from(encoded.replace(/\s/g, ''), 'base64'), extension);
  } catch {
    return null;
  }
}

/**
 * Normalize image from any format.
 *
 * @param {*} imageValue - Raw image value (string, object, etc.)
 * @param {object|null} uploadedFile - Multer uploaded file, if any
 * @param {boolean} saveToFile - Whether to save base64 to disk (true for ingest, false for decode)
 * @returns {string|null}
 */
function normalizeImage(imageValue, uploadedFile, saveToFile) {
  // Priority 1: uploaded file (multer)
  if (uploadedFile) {
    const saved = saveUploadedFile(uploadedFile);
    if (saved) return saved;
  }

  if (!imageValue) return null;

  // Unwrap nested object
  let value = imageValue;
  if (typeof value === 'object' && value !== null) {
    value = value.data || value.base64 || value.content || value.url || value.uri || value.path;
  }
  if (typeof value !== 'string' || !value.trim()) return null;

  value = value.trim();

  // Data URI — persist it for ingestion, or keep it inline for decode-only use.
  if (value.startsWith('data:image/')) {
    return saveToFile ? saveBase64Image(value) : value;
  }

  // URL or absolute path — pass through
  if (/^https?:\/\//i.test(value) || value.startsWith('/')) {
    return value;
  }

  // Base64 raw string
  if (/^[a-z0-9+/\s]+=*$/i.test(value) && value.length > 100) {
    if (saveToFile) {
      return saveBase64Image(value);
    }
    return `data:image/jpeg;base64,${value.replace(/\s/g, '')}`;
  }

  return value;
}

// ──────────────────────────────────────────────
// Vehicle Type Normalization
// ──────────────────────────────────────────────
function normalizeVehicleType(value) {
  if (!value) return 'unknown';
  const lower = String(value).trim().toLowerCase();
  return VEHICLE_TYPE_MAP[lower] || String(value).trim();
}

// ──────────────────────────────────────────────
// Plate Normalization
// ──────────────────────────────────────────────
function normalizePlate(value) {
  if (value === undefined || value === null) return null;
  const plate = String(value).trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  return plate || null;
}

function sanitizeRawPayload(value, seen = new Set()) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(item => sanitizeRawPayload(item, seen)).filter(item => item !== undefined);
  }
  if (typeof value === 'object') {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    const output = {};
    for (const [key, rawValue] of Object.entries(value)) {
      const normalizedKey = key.toLowerCase();
      const isSensitive = /token|secret|password|api[_-]?key|auth|cookie|session/i.test(normalizedKey);
      if (isSensitive) continue;
      output[key] = sanitizeRawPayload(rawValue, seen);
    }
    seen.delete(value);
    return output;
  }
  return String(value);
}

// ──────────────────────────────────────────────
// Violation Normalization (from utils/normalizeDetection.js)
// ──────────────────────────────────────────────
function normalizeViolation(body) {
  const resolved = resolveField(body, 'violations', null, null);
  const violation = resolved?.value || null;

  const tags = [
    ...([violation].filter(Boolean)),
    ...(Array.isArray(body.violation_tags) ? body.violation_tags : []),
  ];
  const normalizedViolations = [...new Set(tags
    .map(v => String(v).trim())
    .filter(v => v && !['none', 'normal', 'ok'].includes(v.toLowerCase())))];
  const normalizedViolation = normalizedViolations.join(', ') || null;
  const booleanFlag = ['is_violation', 'isViolation', 'flagged', 'is_flagged']
    .some(key => body[key] === true || body[key] === 1 || body[key] === 'true');

  return {
    violation_type: normalizedViolation,
    violation_reason: body.violation_reason || null,
    violation_meta: body.violation_meta || null,
    hardware_flagged: Boolean(normalizedViolations.length || booleanFlag),
  };
}

// ──────────────────────────────────────────────
// Confidence Normalization
// ──────────────────────────────────────────────
function normalizeConfidence(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  if (number > 1 && number <= 100) return Number((number / 100).toFixed(4));
  return number;
}

// ──────────────────────────────────────────────
// Vendor Detection
// ──────────────────────────────────────────────
function detectVendor(raw) {
  for (const [name, profile] of Object.entries(VENDOR_PROFILES)) {
    try {
      if (profile.detect(raw)) return { name, profile };
    } catch {
      // ignore detection errors
    }
  }
  return { name: 'generic', profile: null };
}

// ──────────────────────────────────────────────
// Main Entry Point — normalizeDetection()
//
// Replaces: buildDetectionPayload, decodePayload,
//           normalizeDetection, normalizeIncomingDetection
// ──────────────────────────────────────────────

/**
 * Normalize a raw vendor payload into a canonical detection object.
 *
 * @param {object} rawPayload - Raw JSON from camera/vendor
 * @param {object} [options] - Optional context
 * @param {object} [options.uploadedFile] - Multer uploaded file
 * @param {object} [options.camera] - Camera record (for fallback location)
 * @param {boolean} [options.saveImages] - Whether to save base64 images to disk (default: false)
 * @returns {{ detection: object, resolution: object, vendor: string }}
 */
function normalizeDetection(rawPayload, options = {}) {
  const raw = rawPayload && typeof rawPayload === 'object' ? rawPayload : {};
  const { uploadedFile = null, camera = null, saveImages = false } = options;

  // Detect vendor
  const vendor = detectVendor(raw);
  const profile = vendor.profile;
  const vendorName = vendor.name;

  // Resolution tracking — records which strategy resolved each field
  const resolution = {};

  // Helper to resolve and track
  function resolve(fieldName) {
    const result = resolveField(raw, fieldName, profile, vendorName);
    if (result) {
      resolution[fieldName] = result.path;
      return result.value;
    }
    resolution[fieldName] = null;
    return null;
  }

  // Resolve all canonical fields
  const plateRaw = resolve('plate');
  const confidenceRaw = resolve('confidence');
  const vehicleTypeRaw = resolve('vehicle_type');
  const vehicleColorRaw = resolve('vehicle_color');
  const vehicleMakeRaw = resolveField(raw, 'vehicle_make', profile, vendorName);
  if (vehicleMakeRaw) resolution['vehicle_make'] = vehicleMakeRaw.path;
  const speedRaw = resolve('speed');
  const directionRaw = resolve('direction');
  const cameraIdRaw = resolve('camera_id');
  const cameraNameRaw = resolve('camera_name');
  const timestampRaw = resolve('timestamp');
  const eventIdRaw = resolve('event_id');
  const locationIdRaw = resolve('location_id');
  const imageRaw = resolve('image');

  // Speed: also check violation_meta.detected_speed as a last resort
  const speedValue = speedRaw ?? raw.violation_meta?.detected_speed;

  // Violation normalization
  const violation = normalizeViolation(raw);

  // Image normalization
  const imagePath = normalizeImage(imageRaw, uploadedFile, saveImages);

  // Build canonical detection
  const detection = {
    source_format: 'json',
    plate: normalizePlate(plateRaw),
    confidence: normalizeConfidence(confidenceRaw),
    vehicle_type: normalizeVehicleType(vehicleTypeRaw),
    vehicle_color: vehicleColorRaw ? String(vehicleColorRaw).trim() : null,
    vehicle_make: vehicleMakeRaw?.value ? String(vehicleMakeRaw.value).trim() : null,
    speed: Number.isFinite(Number(speedValue)) ? Number(speedValue) : null,
    direction: directionRaw ? String(directionRaw).trim() : null,
    camera_id: cameraIdRaw ? String(cameraIdRaw).trim() : null,
    camera_name: cameraNameRaw ? String(cameraNameRaw).trim() : null,
    timestamp: timestampRaw || new Date().toISOString(),
    event_id: eventIdRaw ? String(eventIdRaw) : null,
    location_id: locationIdRaw ? String(locationIdRaw).trim()
      : (camera?.zone || null),
    image_path: imagePath,
    violation_type: violation.violation_type,
    violation_reason: violation.violation_reason,
    violation_meta: violation.violation_meta,
    hardware_flagged: violation.hardware_flagged,
    raw_payload: typeof raw === 'object' && raw !== null ? JSON.stringify(sanitizeRawPayload(raw)) : String(raw ?? ''),
  };

  // Build resolution summary string for audit log
  const resolvedFields = Object.entries(resolution)
    .filter(([, v]) => v !== null)
    .map(([field, path]) => `${field}=${path}`)
    .join('; ');

  return {
    detection,
    resolution,
    resolutionSummary: resolvedFields || 'none',
    vendor: vendorName,
  };
}

// ──────────────────────────────────────────────
// Batch Expansion (from decode.js)
// ──────────────────────────────────────────────

/**
 * Expand a raw body into an array of individual payloads.
 * Handles arrays, nested batch fields, or single objects.
 */
function expandPayloads(rawBody) {
  if (Array.isArray(rawBody)) return rawBody;
  if (!rawBody || typeof rawBody !== 'object') return [];

  // Check for nested batch arrays
  const batchKeys = ['data', 'results', 'batch', 'detections', 'events', 'records', 'items'];
  for (const key of batchKeys) {
    const val = rawBody[key];
    if (Array.isArray(val) && val.length > 0 && val.every(item => item && typeof item === 'object')) {
      return val;
    }
  }

  // Recursive search for batch arrays
  const nestedResult = resolveByNestedSearch(rawBody, batchKeys);
  if (nestedResult && Array.isArray(nestedResult.value) &&
      nestedResult.value.every(item => item && typeof item === 'object')) {
    return nestedResult.value;
  }

  return [rawBody];
}

module.exports = {
  normalizeDetection,
  normalizeVehicleType,
  normalizePlate,
  normalizeImage,
  normalizeConfidence,
  expandPayloads,
  detectVendor,
  resolveField,
  VENDOR_PROFILES,
  FIELD_ALIASES,
};
