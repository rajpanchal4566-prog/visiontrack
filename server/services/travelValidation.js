const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../database');
const { getOrCreateRoute, validCoordinate } = require('./routeEngine');

function setting(db, key, fallback) {
  const row = db.prepare('SELECT value FROM validation_settings WHERE key = ?').get(key);
  const parsed = row ? Number(row.value) : Number(fallback);
  return Number.isFinite(parsed) ? parsed : Number(fallback);
}

function round(value, decimals = 2) {
  return Number.isFinite(value) ? Number(value.toFixed(decimals)) : null;
}

function scoreValidation({ first, second, elapsedSeconds, speedKmh, impossible, speeding, overspeed, route }) {
  let score = 0;
  const reasons = [];
  if (impossible) { score += 65; reasons.push('IMPOSSIBLE_TRAVEL_TIME'); }
  if (overspeed) { score += 30; reasons.push('OVERSPEED_THRESHOLD_EXCEEDED'); }
  if (speeding) { score += 25; reasons.push('AVERAGE_SPEED_ABOVE_TOLERANCE'); }
  if (Number(first.confidence) < 0.75 || Number(second.confidence) < 0.75) {
    score += 10; reasons.push('LOW_OCR_CONFIDENCE');
  }
  if (Number(first.confidence) < 0.5 || Number(second.confidence) < 0.5) score += 15;
  if (!validCoordinate(first) || !validCoordinate(second)) {
    score += 20;
    reasons.push('INVALID_CAMERA_COORDINATES');
  }
  if (!elapsedSeconds || elapsedSeconds <= 0) reasons.push('INVALID_TIMESTAMP');
  if (route.routeStatus === 'unavailable') reasons.push('ROUTE_UNAVAILABLE');
  if (first.status !== 'online' || second.status !== 'online') reasons.push('CAMERA_NOT_ONLINE');
  return { score: Math.min(100, score), reasons };
}

function findPreviousDetection(db, detection) {
  return db.prepare(`
    SELECT d.*, c.name as camera_name, c.city, c.zone, c.lat, c.lng, c.status, c.speed_limit_kmh
    FROM detections d
    JOIN cameras c ON c.id = d.camera_id
    WHERE d.plate = ? AND d.camera_id != ? AND d.timestamp <= ?
    ORDER BY d.timestamp DESC
    LIMIT 1
  `).get(detection.plate, detection.camera_id, detection.timestamp);
}

async function validateDetection(detection, options = {}) {
  const db = options.db || getDb();
  const second = db.prepare(`
    SELECT d.*, c.name as camera_name, c.city, c.zone, c.lat, c.lng, c.status, c.speed_limit_kmh
    FROM detections d JOIN cameras c ON c.id = d.camera_id WHERE d.id = ?
  `).get(detection.id);
  if (!second) return null;

  const first = findPreviousDetection(db, second);
  if (!first) return null;

  const firstCamera = { id: first.camera_id, lat: first.lat, lng: first.lng };
  const secondCamera = { id: second.camera_id, lat: second.lat, lng: second.lng };
  const route = await getOrCreateRoute(firstCamera, secondCamera, { db });
  const elapsedSeconds = Math.round((new Date(second.timestamp).getTime() - new Date(first.timestamp).getTime()) / 1000);
  const distanceKm = route.road_distance_km ?? route.straight_line_distance_km;
  const speedKmh = elapsedSeconds > 0 && Number.isFinite(distanceKm)
    ? distanceKm / (elapsedSeconds / 3600)
    : null;
  const expectedSeconds = route.estimated_travel_time_seconds;
  const speedLimit = Number(second.speed_limit_kmh) || setting(db, 'default_speed_limit_kmh', 50);
  const tolerance = setting(db, 'speeding_threshold_percentage', 25) / 100;
  const speedThreshold = speedLimit * (1 + tolerance);
  const overspeedThreshold = setting(db, 'overspeed_threshold_kmh', 100);
  const absoluteMaximum = setting(db, 'absolute_maximum_speed_kmh', 220);
  const impossible = elapsedSeconds <= 0
    || (Number.isFinite(speedKmh) && speedKmh > absoluteMaximum)
    || (Number.isFinite(expectedSeconds) && elapsedSeconds < expectedSeconds * 0.2);
  const speeding = Number.isFinite(speedKmh) && speedKmh > speedThreshold;
  const overspeed = Number.isFinite(speedKmh) && speedKmh > overspeedThreshold;
  const scoring = scoreValidation({ first, second, elapsedSeconds, speedKmh, impossible, speeding, overspeed, route });
  const status = impossible ? 'SUSPICIOUS TRAVEL' : scoring.reasons.includes('INVALID_CAMERA_COORDINATES') || elapsedSeconds <= 0
    ? 'DATA ANOMALY' : overspeed ? 'OVERSPEED' : speeding ? 'SPEEDING' : 'NORMAL';
  const reason = scoring.reasons.join(',') || null;

  const insert = db.prepare(`
    INSERT INTO travel_validations (
      plate, first_camera_id, second_camera_id, first_detection_id, second_detection_id,
      distance_km, distance_source, elapsed_time_seconds, calculated_speed_kmh,
      expected_travel_time_seconds, speed_limit_kmh, speed_threshold_kmh, status, reason, suspicion_score
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(first_detection_id, second_detection_id) DO NOTHING
  `);
  insert.run(
    second.plate, first.camera_id, second.camera_id, first.id, second.id,
    round(distanceKm), route.road_distance_km !== null ? 'road' : 'straight_line',
    elapsedSeconds, round(speedKmh), expectedSeconds, speedLimit, speedThreshold, status, reason, scoring.score,
  );
  const validation = db.prepare(`
    SELECT v.*, fc.name as first_camera_name, tc.name as second_camera_name,
      fc.lat as first_camera_lat, fc.lng as first_camera_lng,
      tc.lat as second_camera_lat, tc.lng as second_camera_lng
    FROM travel_validations v
    JOIN cameras fc ON fc.id = v.first_camera_id
    JOIN cameras tc ON tc.id = v.second_camera_id
    WHERE v.first_detection_id = ? AND v.second_detection_id = ?
  `).get(first.id, second.id);

  if (status === 'SUSPICIOUS TRAVEL') {
    db.prepare(`
      INSERT INTO flagged_vehicle_events (
        plate, first_camera_id, second_camera_id, first_detection_id, second_detection_id,
        distance_km, elapsed_time_seconds, calculated_speed_kmh, expected_travel_time_seconds,
        speed_limit_kmh, reason, suspicion_score
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(first_detection_id, second_detection_id) DO NOTHING
    `).run(
      second.plate, first.camera_id, second.camera_id, first.id, second.id,
      round(distanceKm), elapsedSeconds, round(speedKmh), expectedSeconds, speedLimit,
      reason || 'IMPOSSIBLE_TRAVEL_TIME', scoring.score,
    );

    db.prepare(`
      UPDATE detections
      SET flagged = 1,
          violation_type = ?,
          flag_source = 'travel_validation',
          violations = ?
      WHERE id = ?
    `).run('SUSPICIOUS TRAVEL', reason || 'SUSPICIOUS TRAVEL', second.id);
  }

  if (status === 'SUSPICIOUS TRAVEL' || status === 'SPEEDING' || status === 'OVERSPEED') {
    const alertId = `ALT-${uuidv4().slice(0, 8)}`;
    const type = status === 'SUSPICIOUS TRAVEL' ? 'POSSIBLE PLATE SPOOF' : status === 'OVERSPEED' ? 'OVERSPEED TRAVEL' : 'SPEEDING TRAVEL';
    const severity = status === 'SUSPICIOUS TRAVEL' ? 'critical' : 'warning';
    const description = `${type}: ${second.plate} travelled ${first.camera_id} -> ${second.camera_id}; `
      + `${round(distanceKm)} km in ${Math.max(0, Math.round(elapsedSeconds / 60))} min `
      + `at ${round(speedKmh)} km/h (expected ${expectedSeconds ? Math.round(expectedSeconds / 60) : 'unavailable'} min). `
      + `Reasons: ${reason || 'speed threshold exceeded'}`;
    db.prepare(`
      INSERT INTO alerts (id, detection_id, plate, camera_id, timestamp, type, severity, status, description)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)
    `).run(alertId, second.id, second.plate, second.camera_id, second.timestamp, type, severity, description);
    if (global.io) {
      global.io.emit('alert:new', {
        id: alertId, detection_id: second.id, plate: second.plate, camera_id: second.camera_id,
        timestamp: second.timestamp, type, severity, status: 'active', description, validation,
      });
    }
  }

  if (global.io) global.io.emit('travel-validation:new', validation);
  return validation;
}

module.exports = { validateDetection };