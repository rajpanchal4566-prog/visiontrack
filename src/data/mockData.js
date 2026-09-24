// ============================================
// VisionTrack — Dashboard Mock Data
// Realistic Indian license plates, cameras, traffic data
// ============================================

// --- Indian License Plates ---
export const licensePlates = [
  'MH-12-AB-1234', 'DL-01-CA-5678', 'KA-05-MN-9012', 'TN-22-BH-3456',
  'UP-32-XY-7890', 'GJ-06-PQ-2345', 'RJ-14-CD-6789', 'WB-26-EF-0123',
  'AP-09-GH-4567', 'TS-08-JK-8901', 'MP-04-LM-2345', 'HR-26-NO-6789',
  'PB-10-RS-0123', 'KL-07-TU-4567', 'OR-02-VW-8901', 'BR-01-AB-2345',
  'CG-04-CD-6789', 'JH-05-EF-0123', 'UK-07-GH-4567', 'GA-08-JK-8901',
  'MH-04-PQ-1122', 'DL-08-RS-3344', 'KA-01-TU-5566', 'TN-11-VW-7788',
  'UP-80-XY-9900', 'GJ-01-AB-2211', 'RJ-27-CD-4433', 'WB-74-EF-6655',
  'AP-28-GH-8877', 'TS-10-JK-0099', 'MH-02-ZZ-4321', 'DL-03-AA-8765',
  'KA-19-BB-2109', 'TN-07-CC-6543', 'UP-14-DD-0987', 'GJ-05-EE-4321',
  'RJ-20-FF-8765', 'WB-02-GG-2109', 'AP-39-HH-6543', 'TS-13-II-0987',
  'MH-43-KK-1357', 'DL-12-LL-2468', 'KA-03-MM-3579', 'TN-01-NN-4680',
  'UP-65-OO-5791', 'GJ-15-PP-6802', 'RJ-19-QQ-7913', 'WB-41-RR-8024',
  'MH-14-SS-9135', 'DL-05-TT-0246',
];

// --- Vehicle Types ---
export const vehicleTypes = ['Sedan', 'SUV', 'Hatchback', 'Truck', 'Bus', 'Two-Wheeler', 'Auto-Rickshaw', 'Van'];
export const vehicleColors = ['White', 'Black', 'Silver', 'Red', 'Blue', 'Grey', 'Green', 'Yellow'];

// --- Camera Locations (Indian city network) ---
export const cameras = [
  { id: 'CAM-001', name: 'FC Road Junction', lat: 18.5204, lng: 73.8567, zone: 'Zone A', status: 'online', uptime: 99.7 },
  { id: 'CAM-002', name: 'JM Road Signal', lat: 18.5185, lng: 73.8410, zone: 'Zone A', status: 'online', uptime: 98.5 },
  { id: 'CAM-003', name: 'Hinjewadi IT Park', lat: 18.5913, lng: 73.7389, zone: 'Zone B', status: 'online', uptime: 97.2 },
  { id: 'CAM-004', name: 'Swargate Bus Stand', lat: 18.5018, lng: 73.8636, zone: 'Zone A', status: 'online', uptime: 99.1 },
  { id: 'CAM-005', name: 'Katraj Tunnel Entry', lat: 18.4529, lng: 73.8627, zone: 'Zone C', status: 'degraded', uptime: 85.3 },
  { id: 'CAM-006', name: 'Pune Station', lat: 18.5285, lng: 73.8743, zone: 'Zone A', status: 'online', uptime: 99.9 },
  { id: 'CAM-007', name: 'Hadapsar Bypass', lat: 18.5089, lng: 73.9260, zone: 'Zone D', status: 'online', uptime: 96.8 },
  { id: 'CAM-008', name: 'Baner Road', lat: 18.5590, lng: 73.7868, zone: 'Zone B', status: 'offline', uptime: 0 },
  { id: 'CAM-009', name: 'Kothrud Depot', lat: 18.5074, lng: 73.8077, zone: 'Zone B', status: 'online', uptime: 94.5 },
  { id: 'CAM-010', name: 'Viman Nagar', lat: 18.5679, lng: 73.9143, zone: 'Zone D', status: 'online', uptime: 98.0 },
  { id: 'CAM-011', name: 'Magarpatta City Gate', lat: 18.5133, lng: 73.9263, zone: 'Zone D', status: 'online', uptime: 99.5 },
  { id: 'CAM-012', name: 'Shivaji Nagar', lat: 18.5308, lng: 73.8475, zone: 'Zone A', status: 'online', uptime: 97.7 },
];

// --- Generate Random Detections ---
function randomItem(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function generateTimestamp(hoursAgo = 0) {
  const date = new Date();
  date.setHours(date.getHours() - hoursAgo);
  date.setMinutes(randomBetween(0, 59));
  date.setSeconds(randomBetween(0, 59));
  return date;
}

export function generateDetections(count = 50) {
  return Array.from({ length: count }, (_, i) => ({
    id: `DET-${String(i + 1).padStart(5, '0')}`,
    plate: randomItem(licensePlates),
    camera: randomItem(cameras),
    timestamp: generateTimestamp(randomBetween(0, 23)),
    confidence: (85 + Math.random() * 15).toFixed(1),
    vehicleType: randomItem(vehicleTypes),
    vehicleColor: randomItem(vehicleColors),
    speed: randomBetween(15, 80),
  })).sort((a, b) => b.timestamp - a.timestamp);
}

// --- Hourly Traffic Data (24h) ---
export const hourlyTraffic = Array.from({ length: 24 }, (_, hour) => {
  let base;
  if (hour >= 7 && hour <= 10) base = randomBetween(800, 1200); // Morning rush
  else if (hour >= 17 && hour <= 20) base = randomBetween(900, 1400); // Evening rush
  else if (hour >= 11 && hour <= 16) base = randomBetween(500, 800); // Midday
  else if (hour >= 22 || hour <= 5) base = randomBetween(50, 200); // Night
  else base = randomBetween(300, 500);

  return {
    hour: `${String(hour).padStart(2, '0')}:00`,
    vehicles: base,
    trucks: Math.floor(base * 0.12),
    twoWheelers: Math.floor(base * 0.35),
  };
});

// --- Weekly Traffic Data ---
export const weeklyTraffic = [
  { day: 'Mon', vehicles: 18500 },
  { day: 'Tue', vehicles: 19200 },
  { day: 'Wed', vehicles: 20100 },
  { day: 'Thu', vehicles: 19800 },
  { day: 'Fri', vehicles: 22500 },
  { day: 'Sat', vehicles: 16800 },
  { day: 'Sun', vehicles: 12500 },
];

// --- Vehicle Type Distribution ---
export const vehicleDistribution = [
  { type: 'Sedan', count: 3200, color: '#00f0ff' },
  { type: 'SUV', count: 2800, color: '#7c3aed' },
  { type: 'Hatchback', count: 2100, color: '#ec4899' },
  { type: 'Two-Wheeler', count: 5400, color: '#10b981' },
  { type: 'Auto-Rickshaw', count: 1800, color: '#f59e0b' },
  { type: 'Truck', count: 1200, color: '#3b82f6' },
  { type: 'Bus', count: 800, color: '#6366f1' },
  { type: 'Van', count: 600, color: '#f43f5e' },
];

// --- Peak Hours Heatmap Data ---
export const peakHoursData = (() => {
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const data = [];
  days.forEach((day, di) => {
    for (let hour = 0; hour < 24; hour++) {
      let intensity;
      if (hour >= 7 && hour <= 10) intensity = randomBetween(60, 100);
      else if (hour >= 17 && hour <= 20) intensity = randomBetween(70, 100);
      else if (hour >= 11 && hour <= 16) intensity = randomBetween(30, 60);
      else if (hour >= 22 || hour <= 5) intensity = randomBetween(0, 20);
      else intensity = randomBetween(20, 40);

      if (di >= 5) intensity = Math.floor(intensity * 0.7); // Weekend reduction

      data.push({ day, hour, intensity });
    }
  });
  return data;
})();

// --- Alerts ---
export const alertTypes = ['Stolen Vehicle', 'Blacklisted', 'Over-Speeding', 'Wrong Way', 'No Insurance', 'Expired Registration'];
export const alertSeverity = ['critical', 'warning', 'info'];

export function generateAlerts(count = 30) {
  return Array.from({ length: count }, (_, i) => {
    const severity = i < 5 ? 'critical' : i < 15 ? 'warning' : 'info';
    return {
      id: `ALT-${String(i + 1).padStart(4, '0')}`,
      plate: randomItem(licensePlates),
      camera: randomItem(cameras),
      timestamp: generateTimestamp(randomBetween(0, 48)),
      type: i < 5 ? 'Stolen Vehicle' : randomItem(alertTypes),
      severity,
      status: Math.random() > 0.3 ? 'active' : 'resolved',
      description: `Vehicle detected at ${randomItem(cameras).name}`,
    };
  }).sort((a, b) => b.timestamp - a.timestamp);
}

// --- Blacklist / Whitelist ---
export const blacklistedPlates = [
  { plate: 'MH-12-AB-1234', reason: 'Stolen Vehicle', addedOn: '2026-09-01', addedBy: 'Admin' },
  { plate: 'DL-01-CA-5678', reason: 'Traffic Violations (12+)', addedOn: '2026-08-28', addedBy: 'Traffic Dept' },
  { plate: 'UP-32-XY-7890', reason: 'Insurance Expired', addedOn: '2026-09-05', addedBy: 'RTO' },
  { plate: 'KA-05-MN-9012', reason: 'Hit and Run Suspect', addedOn: '2026-09-07', addedBy: 'Police' },
  { plate: 'GJ-06-PQ-2345', reason: 'Court Order', addedOn: '2026-08-15', addedBy: 'Legal' },
];

export const whitelistedPlates = [
  { plate: 'MH-14-SS-9135', reason: 'Government Vehicle', addedOn: '2026-01-01', addedBy: 'Admin' },
  { plate: 'DL-05-TT-0246', reason: 'Emergency Services', addedOn: '2026-01-01', addedBy: 'Admin' },
  { plate: 'KA-01-TU-5566', reason: 'Authorized Staff', addedOn: '2026-06-15', addedBy: 'HR Dept' },
];

// --- System Health Metrics ---
export const systemMetrics = {
  cpu: 67,
  memory: 72,
  gpu: 84,
  storage: { used: 2.4, total: 5.0, unit: 'TB' },
  aiModel: {
    accuracy: 96.8,
    avgInferenceTime: 23, // ms
    platesPerMinute: 142,
    modelVersion: 'VisionTrack-v3.2.1',
    lastUpdated: '2026-09-08',
  },
  totalDetectionsToday: 14832,
  activeCameras: cameras.filter(c => c.status === 'online').length,
  totalCameras: cameras.length,
  alertsToday: 27,
  avgConfidence: 94.2,
};

// --- System Logs ---
export function generateLogs(count = 50) {
  const logTypes = [
    { level: 'info', message: 'Camera feed connected successfully' },
    { level: 'info', message: 'VisionTrack model inference completed' },
    { level: 'info', message: 'Detection synced to database' },
    { level: 'info', message: 'Batch processing completed — 150 plates' },
    { level: 'warning', message: 'Camera feed latency exceeding threshold' },
    { level: 'warning', message: 'Low confidence detection — manual review required' },
    { level: 'warning', message: 'Storage usage exceeding 80%' },
    { level: 'warning', message: 'GPU temperature above normal range' },
    { level: 'error', message: 'Camera connection lost — retrying' },
    { level: 'error', message: 'Database write timeout — retry in 5s' },
    { level: 'error', message: 'AI model inference failed — fallback engaged' },
    { level: 'success', message: 'Alert dispatched to authorities' },
    { level: 'success', message: 'Blacklisted vehicle detected and flagged' },
    { level: 'success', message: 'System backup completed successfully' },
  ];

  return Array.from({ length: count }, (_, i) => {
    const logType = randomItem(logTypes);
    return {
      id: i + 1,
      timestamp: generateTimestamp(randomBetween(0, 12)),
      level: logType.level,
      message: logType.message,
      source: randomItem(['VisionTrack Engine', 'Camera Module', 'Database', 'Alert System', 'Scheduler']),
    };
  }).sort((a, b) => b.timestamp - a.timestamp);
}

// --- Vehicle Search Results ---
export function searchVehicle(plateQuery) {
  const matchingPlates = licensePlates.filter(p =>
    p.toLowerCase().includes(plateQuery.toLowerCase())
  );

  if (matchingPlates.length === 0) return [];

  return matchingPlates.map(plate => {
    const sightings = randomBetween(3, 20);
    const cameraPath = Array.from({ length: sightings }, () => randomItem(cameras));

    return {
      plate,
      vehicleType: randomItem(vehicleTypes),
      vehicleColor: randomItem(vehicleColors),
      firstSeen: generateTimestamp(randomBetween(48, 168)),
      lastSeen: generateTimestamp(randomBetween(0, 6)),
      totalSightings: sightings,
      isBlacklisted: blacklistedPlates.some(b => b.plate === plate),
      isWhitelisted: whitelistedPlates.some(w => w.plate === plate),
      trajectory: cameraPath.map((cam, i) => ({
        camera: cam,
        timestamp: generateTimestamp(sightings - i),
        confidence: (85 + Math.random() * 15).toFixed(1),
      })),
    };
  });
}

// --- Zone Traffic Data ---
export const zoneTraffic = [
  { zone: 'Zone A — Central', vehicles: 8200, cameras: 4 },
  { zone: 'Zone B — West', vehicles: 5600, cameras: 3 },
  { zone: 'Zone C — South', vehicles: 3200, cameras: 1 },
  { zone: 'Zone D — East', vehicles: 6800, cameras: 3 },
];

// --- Top Frequent Plates ---
export const frequentPlates = licensePlates.slice(0, 10).map(plate => ({
  plate,
  count: randomBetween(15, 85),
})).sort((a, b) => b.count - a.count);
