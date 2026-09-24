// ============================================
// VisionTrack — Detection Persistence & Dedup Engine
// Central gateway for persisting ANPR detections.
// Provides spatial + temporal time-window deduplication
// with fuzzy Levenshtein distance matching.
// ============================================
const { getDb } = require('../database');

const DEFAULT_DEDUP_WINDOW_SECONDS = 30;

/**
 * Compute Levenshtein edit distance between two strings.
 * Used to catch OCR variations (e.g. TS09EG6531 vs TS09EGG531).
 */
function levenshteinDistance(a, b) {
  if (a === b) return 0;
  if (!a || !a.length) return (b || '').length;
  if (!b || !b.length) return a.length;

  const row = [];
  for (let j = 0; j <= b.length; j++) row[j] = j;

  for (let i = 1; i <= a.length; i++) {
    let prev = i;
    for (let j = 1; j <= b.length; j++) {
      let val;
      if (a.charAt(i - 1) === b.charAt(j - 1)) {
        val = row[j - 1];
      } else {
        val = Math.min(row[j - 1] + 1, prev + 1, row[j] + 1);
      }
      row[j - 1] = prev;
      prev = val;
    }
    row[b.length] = prev;
  }
  return row[b.length];
}

/**
 * Check if two plate strings are an exact, fuzzy, or prefix match.
 */
function isFuzzyPlateMatch(plateA, plateB) {
  if (!plateA || !plateB) return false;
  const cleanA = String(plateA).toUpperCase().replace(/[^A-Z0-9]/g, '');
  const cleanB = String(plateB).toUpperCase().replace(/[^A-Z0-9]/g, '');

  if (!cleanA || !cleanB) return false;
  if (cleanA === cleanB) return true;

  const maxLen = Math.max(cleanA.length, cleanB.length);
  const minLen = Math.min(cleanA.length, cleanB.length);
  const dist = levenshteinDistance(cleanA, cleanB);

  // For typical 8-10 character Indian plates: allow edit distance <= 2
  if (minLen >= 7 && dist <= 2) return true;

  // For 5-6 character plates: allow edit distance <= 1
  if (minLen >= 5 && dist <= 1) return true;

  // Prefix / truncation match (e.g. AP10AR6 vs AP10AR0658):
  // If one starts with the prefix (>= 5 chars) of the other
  if (minLen >= 5 && (cleanA.startsWith(cleanB.slice(0, 5)) || cleanB.startsWith(cleanA.slice(0, 5)))) {
    return true;
  }

  return false;
}

/**
 * Insert or update a detection record with time-window deduplication.
 *
 * Rules:
 * 1. If exact event_id exists: mark as duplicate.
 * 2. If same camera detected same plate (or fuzzy edit distance <= 1-2) within dedupWindow:
 *    - If new confidence > existing confidence: update existing record with better data.
 *    - Else: suppress insertion and discard duplicate.
 * 3. Otherwise: insert new detection row.
 *
 * @param {object} detection - Detection payload
 * @param {object} [options] - Deduplication options
 * @returns {{ id: string, duplicate: boolean, updated: boolean, matchedPlate?: string }}
 */
function insertDetection(detection, options = {}) {
  const db = getDb();
  const dedupWindowSec = Number(
    options.dedupWindowSeconds ??
    process.env.ANPR_DEDUP_WINDOW_SECONDS ??
    DEFAULT_DEDUP_WINDOW_SECONDS
  );

  // 1. Guard against identical event_id replay
  if (detection.event_id) {
    const existingEvent = db.prepare('SELECT id, event_id FROM detections WHERE event_id = ?').get(detection.event_id);
    if (existingEvent) {
      return { id: existingEvent.id, duplicate: true, updated: false, matchedPlate: detection.plate };
    }
  }

  // 2. Temporal backstop: check recent sightings on the same camera
  const cameraId = detection.camera_id;
  const detectionTime = detection.timestamp ? new Date(detection.timestamp).getTime() : Date.now();
  const windowStartIso = new Date(detectionTime - dedupWindowSec * 1000).toISOString();
  const windowEndIso = new Date(detectionTime + 5000).toISOString();

  if (cameraId && dedupWindowSec > 0) {
    const recentSightings = db.prepare(`
      SELECT id, event_id, plate, camera_id, timestamp, confidence, vehicle_type, speed, image_path, violations, flagged, violation_type, investigation_details
      FROM detections
      WHERE camera_id = ?
        AND timestamp >= ?
        AND timestamp <= ?
      ORDER BY timestamp DESC
    `).all(cameraId, windowStartIso, windowEndIso);

    for (const recent of recentSightings) {
      if (isFuzzyPlateMatch(detection.plate, recent.plate)) {
        const currentConf = Number(detection.confidence || 0);
        const existingConf = Number(recent.confidence || 0);
        const isBetterEvidence = currentConf > existingConf;

        if (isBetterEvidence) {
          // Prefer longer/more complete plate string if confidence is better
          const preferNewPlate = detection.plate.length >= recent.plate.length || currentConf >= existingConf + 0.1;
          const targetPlate = preferNewPlate ? detection.plate : recent.plate;

          db.prepare(`
            UPDATE detections
            SET plate = ?,
                confidence = ?,
                vehicle_type = COALESCE(?, vehicle_type),
                speed = COALESCE(?, speed),
                image_path = COALESCE(?, image_path),
                violations = COALESCE(?, violations),
                flagged = MAX(flagged, ?),
                violation_type = COALESCE(?, violation_type),
                investigation_details = COALESCE(?, investigation_details),
                ocr_text = COALESCE(?, ocr_text),
                ocr_confidence = COALESCE(?, ocr_confidence)
            WHERE id = ?
          `).run(
            targetPlate,
            currentConf,
            detection.vehicle_type || null,
            detection.speed !== null && detection.speed !== undefined ? detection.speed : null,
            detection.image_path || null,
            detection.violations || null,
            detection.flagged ? 1 : 0,
            detection.violation_type || null,
            detection.investigation_details || null,
            detection.ocr_text || null,
            detection.ocr_confidence !== null && detection.ocr_confidence !== undefined ? detection.ocr_confidence : null,
            recent.id,
          );

          return {
            id: recent.id,
            duplicate: true,
            updated: true,
            matchedPlate: recent.plate,
            newPlate: targetPlate,
            existingConfidence: existingConf,
            newConfidence: currentConf,
          };
        }

        // Existing reading has equal or higher confidence: suppress duplicate insertion
        return {
          id: recent.id,
          duplicate: true,
          updated: false,
          matchedPlate: recent.plate,
          existingConfidence: existingConf,
          newConfidence: currentConf,
        };
      }
    }
  }

  // 3. Brand new vehicle / plate sighting: insert into database
  db.prepare(`
    INSERT INTO detections (
      id, event_id, plate, camera_id, location_id, timestamp, confidence,
      vehicle_type, vehicle_color, speed, direction, image_path, violations,
      flagged, violation_type, flag_source, investigation_status,
      investigation_confidence, investigation_details, ocr_text,
      ocr_confidence, ocr_status, source_type
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    detection.id, detection.event_id, detection.plate, detection.camera_id, detection.location_id,
    detection.timestamp, detection.confidence, detection.vehicle_type, detection.vehicle_color,
    detection.speed, detection.direction, detection.image_path, detection.violations, detection.flagged,
    detection.violation_type, detection.flag_source, detection.investigation_status,
    detection.investigation_confidence, detection.investigation_details, detection.ocr_text,
    detection.ocr_confidence, detection.ocr_status, detection.source_type,
  );

  // Synchronously update traffic_stats so analytics charts always reflect real detections
  try {
    updateTrafficStats(detection);
  } catch (err) {
    console.warn(`[Persistence] Error updating traffic_stats: ${err.message}`);
  }

  return { id: detection.id, duplicate: false, updated: false };
}

/**
 * Increment traffic_stats for a persisted vehicle detection.
 */
function updateTrafficStats(detection) {
  if (!detection || !detection.camera_id) return;
  const db = getDb();
  const cameraId = detection.camera_id;

  const dateObj = detection.timestamp ? new Date(detection.timestamp) : new Date();
  const hour = dateObj.getHours();
  const dateStr = dateObj.toISOString().slice(0, 10);
  const timestampKey = `${dateStr} ${String(hour).padStart(2, '0')}:00:00`;

  const normType = String(detection.vehicle_type || 'car').toLowerCase();
  let typeColumn = 'sedan_count';
  if (normType.includes('bike') || normType.includes('motorcycle') || normType.includes('scooter') || normType.includes('two-wheeler')) {
    typeColumn = 'bike_count';
  } else if (normType.includes('truck')) {
    typeColumn = 'truck_count';
  } else if (normType.includes('bus')) {
    typeColumn = 'bus_count';
  } else if (normType.includes('auto')) {
    typeColumn = 'auto_count';
  } else if (normType.includes('suv')) {
    typeColumn = 'suv_count';
  } else {
    typeColumn = 'sedan_count';
  }

  // Ensure camera exists
  db.prepare(`
    INSERT OR IGNORE INTO cameras (id, name, city, lat, lng, zone)
    VALUES (?, ?, 'Pune', 18.5204, 73.8567, 'Zone-1')
  `).run(cameraId, `Camera ${cameraId}`);

  const existing = db.prepare(
    'SELECT id, vehicle_count FROM traffic_stats WHERE camera_id = ? AND hour = ? AND date(timestamp) = ?'
  ).get(cameraId, hour, dateStr);

  if (existing) {
    const count = existing.vehicle_count + 1;
    const congestion = count > 200 ? 'critical' : count > 120 ? 'high' : count > 60 ? 'medium' : 'low';
    db.prepare(`
      UPDATE traffic_stats
      SET vehicle_count = vehicle_count + 1, ${typeColumn} = ${typeColumn} + 1, congestion_level = ?
      WHERE id = ?
    `).run(congestion, existing.id);
  } else {
    db.prepare(`
      INSERT INTO traffic_stats (camera_id, timestamp, hour, vehicle_count, ${typeColumn}, congestion_level)
      VALUES (?, ?, ?, 1, 1, 'low')
    `).run(cameraId, timestampKey, hour);
  }
}

/**
 * Synchronize traffic_stats aggregated from detections table for a given date or all dates.
 */
function syncTrafficStats(targetDate = null) {
  const db = getDb();
  let query = `
    SELECT d.camera_id,
           date(d.timestamp) as day,
           CAST(strftime('%H', d.timestamp) AS INTEGER) as hour,
           COUNT(*) as total_vehicles,
           SUM(CASE WHEN LOWER(d.vehicle_type) IN ('car', 'sedan', 'hatchback') THEN 1 ELSE 0 END) as sedan_count,
           SUM(CASE WHEN LOWER(d.vehicle_type) IN ('bike', 'motorcycle', 'scooter') THEN 1 ELSE 0 END) as bike_count,
           SUM(CASE WHEN LOWER(d.vehicle_type) = 'truck' THEN 1 ELSE 0 END) as truck_count,
           SUM(CASE WHEN LOWER(d.vehicle_type) = 'bus' THEN 1 ELSE 0 END) as bus_count,
           SUM(CASE WHEN LOWER(d.vehicle_type) = 'auto' THEN 1 ELSE 0 END) as auto_count,
           SUM(CASE WHEN LOWER(d.vehicle_type) = 'suv' THEN 1 ELSE 0 END) as suv_count
    FROM detections d
  `;
  const params = [];
  if (targetDate) {
    query += ` WHERE date(d.timestamp) = ?`;
    params.push(targetDate);
  }
  query += ` GROUP BY d.camera_id, day, hour`;

  const rows = db.prepare(query).all(...params);
  for (const r of rows) {
    db.prepare(`
      INSERT OR IGNORE INTO cameras (id, name, city, lat, lng, zone)
      VALUES (?, ?, 'Pune', 18.5204, 73.8567, 'Zone-1')
    `).run(r.camera_id, `Camera ${r.camera_id}`);

    const timestampKey = `${r.day} ${String(r.hour).padStart(2, '0')}:00:00`;
    const existing = db.prepare(
      'SELECT id, vehicle_count FROM traffic_stats WHERE camera_id = ? AND hour = ? AND date(timestamp) = ?'
    ).get(r.camera_id, r.hour, r.day);

    const congestion = r.total_vehicles > 200 ? 'critical' : r.total_vehicles > 120 ? 'high' : r.total_vehicles > 60 ? 'medium' : 'low';

    if (existing) {
      if (existing.vehicle_count < r.total_vehicles) {
        db.prepare(`
          UPDATE traffic_stats
          SET vehicle_count = ?, sedan_count = ?, bike_count = ?, truck_count = ?, bus_count = ?, auto_count = ?, suv_count = ?, congestion_level = ?
          WHERE id = ?
        `).run(r.total_vehicles, r.sedan_count, r.bike_count, r.truck_count, r.bus_count, r.auto_count, r.suv_count, congestion, existing.id);
      }
    } else {
      db.prepare(`
        INSERT INTO traffic_stats (camera_id, timestamp, hour, vehicle_count, sedan_count, bike_count, truck_count, bus_count, auto_count, suv_count, congestion_level)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(r.camera_id, timestampKey, r.hour, r.total_vehicles, r.sedan_count, r.bike_count, r.truck_count, r.bus_count, r.auto_count, r.suv_count, congestion);
    }
  }
}

module.exports = {
  insertDetection,
  updateTrafficStats,
  syncTrafficStats,
  levenshteinDistance,
  isFuzzyPlateMatch,
  DEFAULT_DEDUP_WINDOW_SECONDS,
};