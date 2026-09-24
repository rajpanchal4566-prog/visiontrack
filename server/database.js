// ============================================
// VisionTrack — SQLite Database Setup
// Phase 1: Core tables + Auth & Multi-Org tables
// ============================================
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const DB_PATH = process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : path.join(__dirname, '..', 'anpr.db');
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
  }
  return db;
}

function initializeDatabase() {
  const db = getDb();

  // --- Create Core Tables (original) ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS cameras (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      city TEXT NOT NULL DEFAULT 'Pune',
      lat REAL NOT NULL,
      lng REAL NOT NULL,
      zone TEXT NOT NULL,
      status TEXT DEFAULT 'online' CHECK(status IN ('online','offline','degraded')),
      type TEXT DEFAULT 'both' CHECK(type IN ('metadata','image','both')),
      uptime REAL DEFAULT 99.0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS detections (
      id TEXT PRIMARY KEY,
      event_id TEXT UNIQUE,
      plate TEXT NOT NULL,
      camera_id TEXT NOT NULL,
      timestamp DATETIME NOT NULL,
      confidence REAL NOT NULL,
      vehicle_type TEXT,
      vehicle_color TEXT,
      speed REAL,
      direction TEXT,
      image_path TEXT,
      FOREIGN KEY (camera_id) REFERENCES cameras(id)
    );

    CREATE TABLE IF NOT EXISTS watchlist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plate TEXT NOT NULL UNIQUE,
      reason TEXT,
      added_by TEXT DEFAULT 'Admin',
      added_on DATETIME DEFAULT CURRENT_TIMESTAMP,
      is_active INTEGER DEFAULT 1,
      list_type TEXT DEFAULT 'blacklist' CHECK(list_type IN ('blacklist','whitelist'))
    );

    CREATE TABLE IF NOT EXISTS alerts (
      id TEXT PRIMARY KEY,
      detection_id TEXT,
      plate TEXT NOT NULL,
      camera_id TEXT NOT NULL,
      timestamp DATETIME NOT NULL,
      type TEXT NOT NULL,
      severity TEXT DEFAULT 'warning' CHECK(severity IN ('critical','warning','info')),
      status TEXT DEFAULT 'active' CHECK(status IN ('active','resolved')),
      description TEXT,
      FOREIGN KEY (detection_id) REFERENCES detections(id),
      FOREIGN KEY (camera_id) REFERENCES cameras(id)
    );

    CREATE TABLE IF NOT EXISTS traffic_stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      camera_id TEXT NOT NULL,
      timestamp DATETIME NOT NULL,
      hour INTEGER NOT NULL,
      vehicle_count INTEGER DEFAULT 0,
      sedan_count INTEGER DEFAULT 0,
      bike_count INTEGER DEFAULT 0,
      truck_count INTEGER DEFAULT 0,
      bus_count INTEGER DEFAULT 0,
      auto_count INTEGER DEFAULT 0,
      suv_count INTEGER DEFAULT 0,
      avg_speed REAL DEFAULT 0,
      congestion_level TEXT DEFAULT 'low' CHECK(congestion_level IN ('low','medium','high','critical')),
      FOREIGN KEY (camera_id) REFERENCES cameras(id)
    );

    -- Indexes for fast queries (original)
    CREATE INDEX IF NOT EXISTS idx_detections_plate ON detections(plate);
    CREATE INDEX IF NOT EXISTS idx_detections_camera ON detections(camera_id);
    CREATE INDEX IF NOT EXISTS idx_detections_timestamp ON detections(timestamp);
    CREATE INDEX IF NOT EXISTS idx_alerts_status ON alerts(status);
    CREATE INDEX IF NOT EXISTS idx_alerts_plate ON alerts(plate);
    CREATE INDEX IF NOT EXISTS idx_traffic_camera_hour ON traffic_stats(camera_id, hour);
    CREATE INDEX IF NOT EXISTS idx_watchlist_plate ON watchlist(plate);
  `);

  // --- Create Auth & Multi-Org Tables ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS organizations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      city TEXT NOT NULL,
      state TEXT,
      organization_type TEXT,
      status TEXT DEFAULT 'active',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'operator' CHECK(role IN ('super_admin','admin','operator','viewer')),
      status TEXT DEFAULT 'active',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_login DATETIME,
      FOREIGN KEY (organization_id) REFERENCES organizations(id)
    );

    -- User indexes
    CREATE INDEX IF NOT EXISTS idx_users_organization ON users(organization_id);
    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
  `);

  try {
    db.exec('ALTER TABLE organizations ADD COLUMN api_key TEXT');
  } catch (err) {
    if (!err.message.includes('duplicate column name')) throw err;
  }

  const organizationColumnMigrations = [
    'ALTER TABLE organizations ADD COLUMN parent_organization_id TEXT REFERENCES organizations(id)',
    'ALTER TABLE organizations ADD COLUMN link_key TEXT',
  ];

  for (const migration of organizationColumnMigrations) {
    try {
      db.exec(migration);
    } catch (err) {
      if (!err.message.includes('duplicate column name')) throw err;
    }
  }

  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_organizations_api_key ON organizations(api_key) WHERE api_key IS NOT NULL');
  db.exec('CREATE INDEX IF NOT EXISTS idx_organizations_parent ON organizations(parent_organization_id)');

  // --- Create Servers Table (Step 3) ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS servers (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      name TEXT NOT NULL,
      server_type TEXT DEFAULT 'city_anpr',
      endpoint_url TEXT NOT NULL,
      api_token TEXT NOT NULL,
      status TEXT DEFAULT 'offline',
      last_seen DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (organization_id) REFERENCES organizations(id)
    );

    -- Server indexes
    CREATE INDEX IF NOT EXISTS idx_servers_organization ON servers(organization_id);
    CREATE INDEX IF NOT EXISTS idx_servers_api_token ON servers(api_token);
    CREATE INDEX IF NOT EXISTS idx_servers_status ON servers(status);
  `);

  // --- Migrate cameras table: add new columns (idempotent) ---
  // Must run BEFORE creating indexes on these columns
  const cameraColumnMigrations = [
    "ALTER TABLE cameras ADD COLUMN organization_id TEXT REFERENCES organizations(id)",
    "ALTER TABLE cameras ADD COLUMN api_token TEXT",
    "ALTER TABLE cameras ADD COLUMN endpoint_url TEXT",
    "ALTER TABLE cameras ADD COLUMN endpoint_status TEXT DEFAULT 'unknown'",
    "ALTER TABLE cameras ADD COLUMN last_seen DATETIME",
    "ALTER TABLE cameras ADD COLUMN server_id TEXT REFERENCES servers(id)",
    "ALTER TABLE cameras ADD COLUMN address TEXT",
    "ALTER TABLE cameras ADD COLUMN road TEXT",
    "ALTER TABLE cameras ADD COLUMN speed_limit_kmh REAL",
    "ALTER TABLE cameras ADD COLUMN rtsp_url TEXT",
    "ALTER TABLE cameras ADD COLUMN rtsp_transport TEXT DEFAULT 'tcp'",
    "ALTER TABLE cameras ADD COLUMN sample_fps REAL DEFAULT 2.0",
    "ALTER TABLE cameras ADD COLUMN detect_helmet INTEGER DEFAULT 1",
    "ALTER TABLE cameras ADD COLUMN detect_seatbelt INTEGER DEFAULT 1",
    "ALTER TABLE cameras ADD COLUMN detect_speeding INTEGER DEFAULT 1",
  ];

  for (const migration of cameraColumnMigrations) {
    try {
      db.exec(migration);
    } catch (err) {
      // Column already exists — safe to ignore
      if (!err.message.includes('duplicate column name')) {
        throw err;
      }
    }
  }

  const detectionColumnMigrations = [
    "ALTER TABLE detections ADD COLUMN event_id TEXT",
    "ALTER TABLE detections ADD COLUMN direction TEXT",
    "ALTER TABLE detections ADD COLUMN location_id TEXT",
    "ALTER TABLE detections ADD COLUMN violations TEXT",
    "ALTER TABLE detections ADD COLUMN vehicle_make TEXT",
    "ALTER TABLE detections ADD COLUMN flagged INTEGER DEFAULT 0",
    "ALTER TABLE detections ADD COLUMN violation_type TEXT",
    "ALTER TABLE detections ADD COLUMN flag_source TEXT",
    "ALTER TABLE detections ADD COLUMN investigation_status TEXT",
    "ALTER TABLE detections ADD COLUMN investigation_confidence REAL",
    "ALTER TABLE detections ADD COLUMN investigation_details TEXT",
  ];

  for (const migration of detectionColumnMigrations) {
    try {
      db.exec(migration);
    } catch (err) {
      if (!err.message.includes('duplicate column name')) {
        throw err;
      }
    }
  }

  db.exec(`
    UPDATE detections
    SET event_id = 'legacy-' || id
    WHERE event_id IS NULL OR event_id = '';
  `);

  // --- OCR-related columns on detections ---
  const ocrColumnMigrations = [
    "ALTER TABLE detections ADD COLUMN ocr_text TEXT",
    "ALTER TABLE detections ADD COLUMN ocr_confidence REAL",
    "ALTER TABLE detections ADD COLUMN ocr_status TEXT",
    "ALTER TABLE detections ADD COLUMN source_type TEXT DEFAULT 'camera_anpr'",
  ];

  for (const migration of ocrColumnMigrations) {
    try {
      db.exec(migration);
    } catch (err) {
      if (!err.message.includes('duplicate column name')) throw err;
    }
  }

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_detections_event_id ON detections(event_id);
    CREATE INDEX IF NOT EXISTS idx_detections_flagged ON detections(flagged);
    CREATE INDEX IF NOT EXISTS idx_organizations_api_key_lookup ON organizations(api_key);
  `);

  try {
    db.exec("ALTER TABLE alerts ADD COLUMN source TEXT DEFAULT 'watchlist'");
  } catch (err) {
    if (!err.message.includes('duplicate column name')) throw err;
  }

  // --- Camera column indexes (must come after ALTER TABLE) ---
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_cameras_organization ON cameras(organization_id);
    CREATE INDEX IF NOT EXISTS idx_cameras_api_token ON cameras(api_token);
    CREATE INDEX IF NOT EXISTS idx_cameras_server ON cameras(server_id);
  `);

  // --- Camera network and travel validation tables ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS camera_routes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_camera_id TEXT NOT NULL,
      to_camera_id TEXT NOT NULL,
      straight_line_distance_km REAL NOT NULL,
      road_distance_km REAL,
      estimated_travel_time_seconds INTEGER,
      route_source TEXT NOT NULL DEFAULT 'haversine',
      route_status TEXT NOT NULL DEFAULT 'fallback',
      fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME,
      UNIQUE(from_camera_id, to_camera_id),
      FOREIGN KEY (from_camera_id) REFERENCES cameras(id),
      FOREIGN KEY (to_camera_id) REFERENCES cameras(id)
    );

    CREATE INDEX IF NOT EXISTS idx_camera_routes_from ON camera_routes(from_camera_id);
    CREATE INDEX IF NOT EXISTS idx_camera_routes_to ON camera_routes(to_camera_id);
    CREATE INDEX IF NOT EXISTS idx_camera_routes_expiry ON camera_routes(expires_at);

    CREATE TABLE IF NOT EXISTS validation_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    INSERT OR IGNORE INTO validation_settings (key, value) VALUES
      ('speeding_threshold_percentage', '25'),
      ('absolute_maximum_speed_kmh', '220'),
      ('overspeed_threshold_kmh', '100'),
      ('default_speed_limit_kmh', '50'),
      ('default_travel_speed_kmh', '40'),
      ('route_cache_ttl_hours', '168'),
      ('route_max_distance_km', '250');

    INSERT INTO validation_settings (key, value)
    SELECT 'overspeed_threshold_kmh', '100'
    WHERE NOT EXISTS (SELECT 1 FROM validation_settings WHERE key = 'overspeed_threshold_kmh');

    CREATE TABLE IF NOT EXISTS travel_validations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plate TEXT NOT NULL,
      first_camera_id TEXT NOT NULL,
      second_camera_id TEXT NOT NULL,
      first_detection_id TEXT NOT NULL,
      second_detection_id TEXT NOT NULL,
      distance_km REAL,
      distance_source TEXT,
      elapsed_time_seconds INTEGER,
      calculated_speed_kmh REAL,
      expected_travel_time_seconds INTEGER,
      speed_limit_kmh REAL,
      status TEXT NOT NULL CHECK(status IN ('NORMAL','SPEEDING','OVERSPEED','SUSPICIOUS TRAVEL','DATA ANOMALY')),
      reason TEXT,
      suspicion_score INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(first_detection_id, second_detection_id),
      FOREIGN KEY (first_camera_id) REFERENCES cameras(id),
      FOREIGN KEY (second_camera_id) REFERENCES cameras(id),
      FOREIGN KEY (first_detection_id) REFERENCES detections(id),
      FOREIGN KEY (second_detection_id) REFERENCES detections(id)
    );

    CREATE INDEX IF NOT EXISTS idx_travel_validations_plate ON travel_validations(plate);
    CREATE INDEX IF NOT EXISTS idx_travel_validations_status ON travel_validations(status);
    CREATE INDEX IF NOT EXISTS idx_travel_validations_created ON travel_validations(created_at);

    CREATE TABLE IF NOT EXISTS flagged_vehicle_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plate TEXT NOT NULL,
      first_camera_id TEXT NOT NULL,
      second_camera_id TEXT NOT NULL,
      first_detection_id TEXT NOT NULL,
      second_detection_id TEXT NOT NULL,
      distance_km REAL,
      elapsed_time_seconds INTEGER,
      calculated_speed_kmh REAL,
      expected_travel_time_seconds INTEGER,
      speed_limit_kmh REAL,
      reason TEXT NOT NULL,
      suspicion_score INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'NEW' CHECK(status IN ('NEW','UNDER_REVIEW','VERIFIED','DISMISSED')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(first_detection_id, second_detection_id),
      FOREIGN KEY (first_camera_id) REFERENCES cameras(id),
      FOREIGN KEY (second_camera_id) REFERENCES cameras(id)
    );

    CREATE INDEX IF NOT EXISTS idx_flagged_events_plate ON flagged_vehicle_events(plate);
    CREATE INDEX IF NOT EXISTS idx_flagged_events_status ON flagged_vehicle_events(status);
  `);

  try {
    db.exec('ALTER TABLE travel_validations ADD COLUMN speed_threshold_kmh REAL');
  } catch (err) {
    if (!err.message.includes('duplicate column name')) throw err;
  }

  const travelValidationTableSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'travel_validations'").pluck().get();
  if (travelValidationTableSql && !travelValidationTableSql.includes("'OVERSPEED'")) {
    const rows = db.prepare('SELECT * FROM travel_validations').all();
    db.exec('ALTER TABLE travel_validations RENAME TO travel_validations_legacy');
    db.exec(`
      CREATE TABLE travel_validations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        plate TEXT NOT NULL,
        first_camera_id TEXT NOT NULL,
        second_camera_id TEXT NOT NULL,
        first_detection_id TEXT NOT NULL,
        second_detection_id TEXT NOT NULL,
        distance_km REAL,
        distance_source TEXT,
        elapsed_time_seconds INTEGER,
        calculated_speed_kmh REAL,
        expected_travel_time_seconds INTEGER,
        speed_limit_kmh REAL,
        speed_threshold_kmh REAL,
        status TEXT NOT NULL CHECK(status IN ('NORMAL','SPEEDING','OVERSPEED','SUSPICIOUS TRAVEL','DATA ANOMALY')),
        reason TEXT,
        suspicion_score INTEGER NOT NULL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(first_detection_id, second_detection_id),
        FOREIGN KEY (first_camera_id) REFERENCES cameras(id),
        FOREIGN KEY (second_camera_id) REFERENCES cameras(id),
        FOREIGN KEY (first_detection_id) REFERENCES detections(id),
        FOREIGN KEY (second_detection_id) REFERENCES detections(id)
      )
    `);
    if (rows.length) {
      const columns = [
        'plate', 'first_camera_id', 'second_camera_id', 'first_detection_id', 'second_detection_id',
        'distance_km', 'distance_source', 'elapsed_time_seconds', 'calculated_speed_kmh',
        'expected_travel_time_seconds', 'speed_limit_kmh', 'speed_threshold_kmh', 'status', 'reason', 'suspicion_score', 'created_at'
      ];
      const placeholders = columns.map(() => '?').join(', ');
      const insert = db.prepare(`INSERT INTO travel_validations (${columns.join(', ')}) VALUES (${placeholders})`);
      for (const row of rows) {
        insert.run(...columns.map(column => row[column]));
      }
    }
    db.exec('DROP TABLE travel_validations_legacy');
    db.exec('CREATE INDEX IF NOT EXISTS idx_travel_validations_plate ON travel_validations(plate)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_travel_validations_status ON travel_validations(status)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_travel_validations_created ON travel_validations(created_at)');
  }

  // --- Create Flagged Vehicles Table (JSON Decoder / Flagging System) ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS flagged_vehicles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plate TEXT NOT NULL,
      flag_type TEXT NOT NULL CHECK(flag_type IN ('stolen','wanted','expired_registration','traffic_violation','insurance_lapsed','tax_defaulter','suspicious','custom')),
      severity TEXT DEFAULT 'warning' CHECK(severity IN ('critical','high','warning','info')),
      description TEXT,
      issuing_authority TEXT,
      case_number TEXT,
      is_active INTEGER DEFAULT 1,
      flagged_on DATETIME DEFAULT CURRENT_TIMESTAMP,
      expires_on DATETIME
    );

    CREATE INDEX IF NOT EXISTS idx_flagged_plate ON flagged_vehicles(plate);
    CREATE INDEX IF NOT EXISTS idx_flagged_type ON flagged_vehicles(flag_type);
    CREATE INDEX IF NOT EXISTS idx_flagged_active ON flagged_vehicles(is_active);

    CREATE TABLE IF NOT EXISTS ingest_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      raw_json TEXT NOT NULL,
      decoded_plate TEXT,
      camera_id TEXT,
      flag_hit INTEGER DEFAULT 0,
      flag_details TEXT,
      resolution_path TEXT,
      received_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_ingest_log_plate ON ingest_log(decoded_plate);
    CREATE INDEX IF NOT EXISTS idx_ingest_log_received ON ingest_log(received_at);
  `);

  try {
    db.exec('ALTER TABLE ingest_log ADD COLUMN resolution_path TEXT');
  } catch (err) {
    if (!err.message.includes('duplicate column name')) throw err;
  }

  console.log('✅ Database tables created (core + auth/multi-org + servers + flagging)');
  try {
    const { syncTrafficStats } = require('./services/detectionPersistence');
    syncTrafficStats();
  } catch (_) {}
}

function seedDatabase() {
  const db = getDb();
  const organizations = db.prepare('SELECT id FROM organizations WHERE api_key IS NULL').all();
  const updateKey = db.prepare('UPDATE organizations SET api_key = ? WHERE id = ?');
  for (const organization of organizations) {
    const apiKey = `anpr_${crypto.randomBytes(24).toString('hex')}`;
    updateKey.run(apiKey, organization.id);
    console.log(`Generated organization API key for ${organization.id}: ${apiKey}`);
  }
}

module.exports = { getDb, initializeDatabase, seedDatabase, DB_PATH };
