// ============================================
// VisionTrack — Virtual Camera Simulator
// Simulates traffic cameras sending detections
// ============================================
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../database');

// --- Update traffic stats per camera per hour ---
function updateTrafficStats(cameraId, vehicleType) {
  const db = getDb();
  const now = new Date();
  const hour = now.getHours();
  const dateStr = now.toISOString().slice(0, 10);
  const timestampKey = `${dateStr} ${String(hour).padStart(2, '0')}:00:00`;

  const normType = vehicleType || 'Sedan';
  const existing = db.prepare(
    'SELECT id, vehicle_count FROM traffic_stats WHERE camera_id = ? AND hour = ? AND date(timestamp) = ?'
  ).get(cameraId, hour, dateStr);

  const typeColumn = {
    'Sedan': 'sedan_count', 'SUV': 'sedan_count', 'Hatchback': 'sedan_count',
    'Bike': 'bike_count', 'Truck': 'truck_count', 'Bus': 'bus_count',
    'Auto': 'auto_count', 'Van': 'truck_count', 'car': 'sedan_count',
    'motorcycle': 'bike_count', 'bus': 'bus_count', 'truck': 'truck_count',
    'van': 'truck_count', 'unknown': 'sedan_count',
  }[normType] || 'sedan_count';

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

// --- Check watchlist and create alert ---
function checkWatchlist(detection, io) {
  const db = getDb();
  const watchlistEntry = db.prepare(
    'SELECT * FROM watchlist WHERE plate = ? AND is_active = 1 AND list_type = ?'
  ).get(detection.plate, 'blacklist');

  if (watchlistEntry) {
    const alert = {
      id: `ALT-${uuidv4().slice(0, 8)}`,
      detection_id: detection.id,
      plate: detection.plate,
      camera_id: detection.camera_id,
      timestamp: detection.timestamp,
      type: watchlistEntry.reason,
      severity: 'critical',
      status: 'active',
      source: 'watchlist',
      description: `Watchlist vehicle "${detection.plate}" detected at ${detection.camera.name} (${detection.camera.city}). Reason: ${watchlistEntry.reason}`,
    };

    db.prepare(`
      INSERT INTO alerts (id, detection_id, plate, camera_id, timestamp, type, severity, status, description)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(alert.id, alert.detection_id, alert.plate, alert.camera_id, alert.timestamp,
      alert.type, alert.severity, alert.status, alert.description);

    const previousSightings = db.prepare(`
      SELECT d.*, c.name as camera_name, c.city as camera_city, c.lat, c.lng 
      FROM detections d JOIN cameras c ON d.camera_id = c.id 
      WHERE d.plate = ? ORDER BY d.timestamp DESC LIMIT 10
    `).all(detection.plate);

    if (io) {
      const event = {
        ...alert,
        camera: detection.camera,
        previousSightings,
        watchlistReason: watchlistEntry.reason,
      };
      if (detection.camera.organization_id) {
        io.to(detection.camera.organization_id).emit('alert:new', event);
        const parent = db.prepare('SELECT parent_organization_id FROM organizations WHERE id = ?').get(detection.camera.organization_id);
        if (parent?.parent_organization_id) io.to(parent.parent_organization_id).emit('alert:new', event);
      } else {
        io.emit('alert:new', event);
      }
    }

    console.log(`🚨 ALERT: Watchlist vehicle ${detection.plate} at ${detection.camera.name} (${detection.camera.city})`);
    return alert;
  }
  return null;
}

module.exports = { checkWatchlist, updateTrafficStats };
