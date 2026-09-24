const express = require('express');
const router = express.Router();
const { getDb } = require('../database');
const { optionalAuth, getOrgCameraFilter } = require('../middleware/authMiddleware');
const { syncTrafficStats } = require('../services/detectionPersistence');

// Apply optional auth to all analytics routes
router.use(optionalAuth);

function requestedDate(value) {
  const raw = String(value || '');
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60000;
  return new Date(now.getTime() - offset).toISOString().slice(0, 10);
}

function scopedDetectionJoin(orgId, params) {
  if (!orgId) return '';
  params.unshift(orgId);
  return ' JOIN cameras c ON d.camera_id = c.id AND c.organization_id = ?';
}

// GET /api/analytics/traffic — Hourly traffic for today (or given date)
router.get('/traffic', (req, res) => {
  const db = getDb();
  const date = requestedDate(req.query.date);
  const orgId = getOrgCameraFilter(req);

  // Self-healing: if traffic_stats has no rows for this date, sync from detections
  const existingCount = db.prepare('SELECT COUNT(*) as count FROM traffic_stats WHERE date(timestamp) = ?').get(date);
  if (!existingCount || existingCount.count === 0) {
    try {
      syncTrafficStats(date);
    } catch (err) {
      console.warn(`[Analytics] Error syncing traffic stats: ${err.message}`);
    }
  }

  let query = `
    SELECT hour, 
      SUM(vehicle_count) as vehicles,
      SUM(sedan_count) as sedans,
      SUM(bike_count) as bikes,
      SUM(truck_count) as trucks,
      SUM(bus_count) as buses,
      SUM(auto_count) as autos
    FROM traffic_stats ts
  `;
  const params = [];

  if (orgId) {
    query += ' JOIN cameras c ON ts.camera_id = c.id WHERE date(ts.timestamp) = ? AND c.organization_id = ?';
    params.push(date, orgId);
  } else {
    query += ' WHERE date(ts.timestamp) = ?';
    params.push(date);
  }
  query += ' GROUP BY hour ORDER BY hour';

  const hourly = db.prepare(query).all(...params);

  // Fill missing hours with zeros
  const fullDay = Array.from({ length: 24 }, (_, h) => {
    const found = hourly.find(r => r.hour === h);
    return {
      hour: `${String(h).padStart(2, '0')}:00`,
      vehicles: found?.vehicles || 0,
      sedans: found?.sedans || 0,
      bikes: found?.bikes || 0,
      cars: (found?.sedans || 0) + (found?.suvs || 0),
      trucks: found?.trucks || 0,
      buses: found?.buses || 0,
      autos: found?.autos || 0,
    };
  });

  res.json(fullDay);
});

// GET /api/analytics/heatmap — Camera density for map heatmap
router.get('/heatmap', (req, res) => {
  const db = getDb();
  const date = requestedDate(req.query.date);
  const orgId = getOrgCameraFilter(req);

  let dataQuery = `
    SELECT ts.camera_id, SUM(ts.vehicle_count) as vehicle_count,
      c.name, c.lat, c.lng, c.zone
    FROM traffic_stats ts
    JOIN cameras c ON ts.camera_id = c.id
    WHERE date(ts.timestamp) = ?
  `;
  const dataParams = [date];
  if (orgId) { dataQuery += ' AND c.organization_id = ?'; dataParams.push(orgId); }
  dataQuery += ' GROUP BY ts.camera_id, c.name, c.lat, c.lng, c.zone';

  const data = db.prepare(dataQuery).all(...dataParams);

  // Also include cameras with no traffic data
  let camerasQuery = 'SELECT * FROM cameras';
  const camerasParams = [];
  if (orgId) { camerasQuery += ' WHERE organization_id = ?'; camerasParams.push(orgId); }

  const allCameras = db.prepare(camerasQuery).all(...camerasParams);
  const heatmapData = allCameras.map(cam => {
    const stats = data.find(d => d.camera_id === cam.id);
    return {
      camera_id: cam.id,
      name: cam.name,
      lat: cam.lat,
      lng: cam.lng,
      zone: cam.zone,
      vehicle_count: stats?.vehicle_count || 0,
      congestion_level: stats?.vehicle_count > 200 ? 'critical' : stats?.vehicle_count > 120 ? 'high' : stats?.vehicle_count > 60 ? 'medium' : 'low',
    };
  });

  res.json(heatmapData);
});

// GET /api/analytics/congestion — Top congested areas
router.get('/congestion', (req, res) => {
  const db = getDb();
  const date = requestedDate(req.query.date);
  const orgId = getOrgCameraFilter(req);

  let query = `
    SELECT ts.camera_id, ts.vehicle_count, ts.congestion_level,
      c.name, c.lat, c.lng, c.zone
    FROM traffic_stats ts
    JOIN cameras c ON ts.camera_id = c.id
    WHERE date(ts.timestamp) = ?
  `;
  const params = [date];
  if (orgId) { query += ' AND c.organization_id = ?'; params.push(orgId); }
  query += ' ORDER BY ts.vehicle_count DESC';

  const congested = db.prepare(query).all(...params);
  res.json(congested);
});

// GET /api/analytics/vehicle-types — Distribution by vehicle type
router.get('/vehicle-types', (req, res) => {
  const db = getDb();
  const date = requestedDate(req.query.date);
  const orgId = getOrgCameraFilter(req);

  let query = `
    SELECT d.vehicle_type as type, COUNT(*) as count 
    FROM detections d
  `;
  const params = [date];

  if (orgId) {
    query += ' JOIN cameras c ON d.camera_id = c.id WHERE date(d.timestamp) = ? AND c.organization_id = ?';
    params.push(orgId);
  } else {
    query += ' WHERE date(d.timestamp) = ?';
  }
  query += ' GROUP BY d.vehicle_type ORDER BY count DESC';

  const distribution = db.prepare(query).all(...params);

  const colors = {
    'Sedan': '#00f0ff', 'SUV': '#7c3aed', 'Hatchback': '#ec4899',
    'Bike': '#10b981', 'Auto': '#f59e0b', 'Truck': '#3b82f6',
    'Bus': '#6366f1', 'Van': '#f43f5e', 'car': '#f97316', 'motorcycle': '#10b981',
  };

  const result = distribution.map(d => ({ ...d, color: colors[d.type] || colors[String(d.type || '').toLowerCase()] || '#a855f7' }));
  res.json(result);
});

// GET /api/analytics/comparison — Compare two dates
router.get('/comparison', (req, res) => {
  const db = getDb();
  const today = requestedDate();
  const yesterday = new Date(Date.now() - 86400000);
  const yesterdayString = new Date(yesterday.getTime() - (yesterday.getTimezoneOffset() * 60000)).toISOString().slice(0, 10);
  const date1 = requestedDate(req.query.date1 || today);
  const date2 = requestedDate(req.query.date2 || yesterdayString);
  const orgId = getOrgCameraFilter(req);

  const getHourly = (date) => {
    let query = `
      SELECT hour, SUM(vehicle_count) as vehicles
      FROM traffic_stats ts
    `;
    const params = [date];
    if (orgId) {
      query += ' JOIN cameras c ON ts.camera_id = c.id WHERE date(ts.timestamp) = ? AND c.organization_id = ?';
      params.push(orgId);
    } else {
      query += ' WHERE date(ts.timestamp) = ?';
    }
    query += ' GROUP BY hour ORDER BY hour';
    return db.prepare(query).all(...params);
  };

  const data1 = getHourly(date1);
  const data2 = getHourly(date2);

  const comparison = Array.from({ length: 24 }, (_, h) => ({
    hour: `${String(h).padStart(2, '0')}:00`,
    [date1]: data1.find(r => r.hour === h)?.vehicles || 0,
    [date2]: data2.find(r => r.hour === h)?.vehicles || 0,
  }));

  res.json({ date1, date2, comparison });
});

// GET /api/analytics/zone-traffic — Zone-wise breakdown
router.get('/zone-traffic', (req, res) => {
  const db = getDb();
  const date = requestedDate(req.query.date);
  const orgId = getOrgCameraFilter(req);

  let query = `
    SELECT c.zone, SUM(ts.vehicle_count) as vehicles, COUNT(DISTINCT c.id) as cameras
    FROM traffic_stats ts
    JOIN cameras c ON ts.camera_id = c.id
    WHERE date(ts.timestamp) = ?
  `;
  const params = [date];
  if (orgId) { query += ' AND c.organization_id = ?'; params.push(orgId); }
  query += ' GROUP BY c.zone ORDER BY vehicles DESC';

  const zones = db.prepare(query).all(...params);
  res.json(zones);
});

// GET /api/analytics/camera-traffic — Traffic per camera
router.get('/camera-traffic', (req, res) => {
  const db = getDb();
  const { camera_id } = req.query;
  const date = requestedDate(req.query.date);
  const orgId = getOrgCameraFilter(req);

  let query = `
    SELECT ts.hour, ts.vehicle_count, ts.congestion_level, ts.camera_id, c.name
    FROM traffic_stats ts
    JOIN cameras c ON ts.camera_id = c.id
    WHERE date(ts.timestamp) = ?
  `;
  const params = [date];
  if (orgId) { query += ' AND c.organization_id = ?'; params.push(orgId); }
  if (camera_id) { query += ' AND ts.camera_id = ?'; params.push(camera_id); }
  query += ' ORDER BY ts.camera_id, ts.hour';

  res.json(db.prepare(query).all(...params));
});

// GET /api/analytics/day-summary — Full metrics for one selected day.
router.get('/day-summary', (req, res) => {
  const db = getDb();
  const date = requestedDate(req.query.date);
  const orgId = getOrgCameraFilter(req);
  const countParams = [date];
  const countJoin = scopedDetectionJoin(orgId, countParams);
  const totals = db.prepare(`
    SELECT COUNT(*) as totalDetections,
      SUM(CASE WHEN d.flagged = 1 THEN 1 ELSE 0 END) as totalFlagged,
      AVG(CASE WHEN d.confidence > 1 THEN d.confidence / 100.0 ELSE d.confidence END) as avgConfidence
    FROM detections d${countJoin}
    WHERE date(d.timestamp) = ?
  `).get(...countParams);

  const violationParams = [date];
  const violationJoin = scopedDetectionJoin(orgId, violationParams);
  const byViolationType = db.prepare(`
    SELECT COALESCE(d.violation_type, 'Unspecified') as violation_type, COUNT(*) as count
    FROM detections d${violationJoin}
    WHERE date(d.timestamp) = ? AND d.flagged = 1
    GROUP BY d.violation_type ORDER BY count DESC
  `).all(...violationParams);

  const vehicleParams = [date];
  const vehicleJoin = scopedDetectionJoin(orgId, vehicleParams);
  const byVehicleType = db.prepare(`
    SELECT COALESCE(d.vehicle_type, 'Unknown') as vehicle_type, COUNT(*) as count
    FROM detections d${vehicleJoin}
    WHERE date(d.timestamp) = ?
    GROUP BY d.vehicle_type ORDER BY count DESC
  `).all(...vehicleParams);

  res.json({
    date,
    totalDetections: totals.totalDetections || 0,
    totalFlagged: totals.totalFlagged || 0,
    avgConfidence: Number((((totals.avgConfidence || 0) * 100)).toFixed(1)),
    byViolationType,
    byVehicleType,
  });
});

// GET /api/analytics/day-over-day — Today, yesterday, and seven-day trend.
router.get('/day-over-day', (req, res) => {
  const db = getDb();
  const today = new Date();
  const dates = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(today);
    date.setDate(today.getDate() - (6 - index));
    return date.toISOString().slice(0, 10);
  });
  const orgId = getOrgCameraFilter(req);
  const params = [...dates];
  let query = `
    SELECT date(d.timestamp) as date, COUNT(*) as totalDetections,
      SUM(CASE WHEN d.flagged = 1 THEN 1 ELSE 0 END) as totalFlagged
    FROM detections d
  `;
  if (orgId) { query += ' JOIN cameras c ON d.camera_id = c.id AND c.organization_id = ?'; params.unshift(orgId); }
  query += ` WHERE date(d.timestamp) IN (${dates.map(() => '?').join(', ')}) GROUP BY date(d.timestamp)`;
  const rows = db.prepare(query).all(...params);
  const last7Days = dates.map(date => {
    const row = rows.find(item => item.date === date);
    return { date, totalDetections: row?.totalDetections || 0, totalFlagged: row?.totalFlagged || 0 };
  });
  const current = last7Days[6];
  const previous = last7Days[5];
  const change = (currentValue, previousValue) => previousValue === 0 ? null : ((currentValue - previousValue) / previousValue) * 100;

  res.json({
    today: { totalDetections: current.totalDetections, totalFlagged: current.totalFlagged },
    yesterday: { totalDetections: previous.totalDetections, totalFlagged: previous.totalFlagged },
    percentChangeDetections: change(current.totalDetections, previous.totalDetections),
    percentChangeFlagged: change(current.totalFlagged, previous.totalFlagged),
    last7Days,
  });
});

module.exports = router;
