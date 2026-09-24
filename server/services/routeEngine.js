const { getDb } = require('../database');

const EARTH_RADIUS_KM = 6371;

function getSetting(db, key, fallback) {
  const row = db.prepare('SELECT value FROM validation_settings WHERE key = ?').get(key);
  const value = row ? Number(row.value) : Number(fallback);
  return Number.isFinite(value) ? value : Number(fallback);
}

function validCoordinate(camera) {
  return Number.isFinite(Number(camera?.lat))
    && Number.isFinite(Number(camera?.lng))
    && Number(camera.lat) >= -90 && Number(camera.lat) <= 90
    && Number(camera.lng) >= -180 && Number(camera.lng) <= 180
    && !(Number(camera.lat) === 0 && Number(camera.lng) === 0);
}

function haversineKm(first, second) {
  const lat1 = Number(first.lat) * Math.PI / 180;
  const lat2 = Number(second.lat) * Math.PI / 180;
  const deltaLat = lat2 - lat1;
  const deltaLng = (Number(second.lng) - Number(first.lng)) * Math.PI / 180;
  const value = Math.sin(deltaLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) ** 2;
  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

function routeTtlDate(db) {
  const ttlHours = getSetting(db, 'route_cache_ttl_hours', 168);
  return new Date(Date.now() + ttlHours * 60 * 60 * 1000).toISOString();
}

async function requestRoadRoute(first, second) {
  const apiKey = process.env.ROUTING_API_KEY;
  if (!apiKey) {
    console.warn('[route-engine] Missing ROUTING_API_KEY; using haversine fallback estimate.');
    return null;
  }
  if (typeof fetch !== 'function') {
    console.warn('[route-engine] Fetch API unavailable in this runtime; using haversine fallback estimate.');
    return null;
  }

  const baseUrl = process.env.ROUTING_API_BASE_URL
    || 'https://api.openrouteservice.org/v2/directions/driving-car';
  const url = new URL(baseUrl);
  url.searchParams.set('api_key', apiKey);
  url.searchParams.set('start', `${first.lng},${first.lat}`);
  url.searchParams.set('end', `${second.lng},${second.lat}`);

  const attempts = 3;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 7000);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) throw new Error(`Routing service returned ${response.status}`);
      const data = await response.json();
      const summary = data.routes?.[0]?.summary;
      if (!summary || !Number.isFinite(summary.distance) || !Number.isFinite(summary.duration)) {
        throw new Error('Routing service returned no route summary');
      }
      return {
        roadDistanceKm: summary.distance / 1000,
        expectedTravelTimeSeconds: Math.max(1, Math.round(summary.duration)),
      };
    } catch (error) {
      if (attempt === attempts - 1) {
        console.warn(`[route-engine] Road route lookup failed for ${first.id} -> ${second.id}: ${error.message}`);
      }
    } finally {
      clearTimeout(timeout);
    }
    await new Promise(resolve => setTimeout(resolve, 150 * (2 ** attempt)));
  }
  return null;
}

async function calculateRoute(first, second, db = getDb()) {
  const straightLineDistanceKm = validCoordinate(first) && validCoordinate(second)
    ? haversineKm(first, second)
    : null;
  if (straightLineDistanceKm === null) {
    return {
      straightLineDistanceKm: null,
      roadDistanceKm: null,
      estimatedTravelTimeSeconds: null,
      routeSource: 'unavailable',
      routeStatus: 'unavailable',
    };
  }

  const maxDistance = getSetting(db, 'route_max_distance_km', 250);
  if (straightLineDistanceKm > maxDistance) {
    return {
      straightLineDistanceKm,
      roadDistanceKm: null,
      estimatedTravelTimeSeconds: null,
      routeSource: 'unavailable',
      routeStatus: 'out_of_range',
    };
  }

  const roadRoute = await requestRoadRoute(first, second);
  if (roadRoute) {
    return {
      straightLineDistanceKm,
      roadDistanceKm: roadRoute.roadDistanceKm,
      estimatedTravelTimeSeconds: roadRoute.expectedTravelTimeSeconds,
      routeSource: 'openrouteservice',
      routeStatus: 'available',
    };
  }

  const fallbackSpeedKmh = getSetting(db, 'default_travel_speed_kmh', 40);
  const fallbackTravelSeconds = Number.isFinite(straightLineDistanceKm) && fallbackSpeedKmh > 0
    ? Math.max(1, Math.round((straightLineDistanceKm / fallbackSpeedKmh) * 3600))
    : null;

  return {
    straightLineDistanceKm,
    roadDistanceKm: null,
    estimatedTravelTimeSeconds: fallbackTravelSeconds,
    routeSource: 'haversine',
    routeStatus: 'fallback',
  };
}

async function getOrCreateRoute(first, second, options = {}) {
  const db = options.db || getDb();
  const forceRefresh = Boolean(options.forceRefresh);
  const cached = db.prepare(`
    SELECT * FROM camera_routes
    WHERE from_camera_id = ? AND to_camera_id = ?
      AND (? = 1 OR expires_at IS NULL OR expires_at > datetime('now'))
  `).get(first.id, second.id, forceRefresh ? 0 : 1);
  if (cached && !forceRefresh) return cached;

  const route = await calculateRoute(first, second, db);
  if (route.straightLineDistanceKm === null) {
    return {
      from_camera_id: first.id,
      to_camera_id: second.id,
      straight_line_distance_km: null,
      road_distance_km: null,
      estimated_travel_time_seconds: null,
      route_source: route.routeSource,
      route_status: route.routeStatus,
      fetched_at: new Date().toISOString(),
      expires_at: null,
    };
  }
  const expiresAt = route.routeStatus === 'unavailable' ? null : routeTtlDate(db);
  db.prepare(`
    INSERT INTO camera_routes (
      from_camera_id, to_camera_id, straight_line_distance_km, road_distance_km,
      estimated_travel_time_seconds, route_source, route_status, fetched_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)
    ON CONFLICT(from_camera_id, to_camera_id) DO UPDATE SET
      straight_line_distance_km = excluded.straight_line_distance_km,
      road_distance_km = excluded.road_distance_km,
      estimated_travel_time_seconds = excluded.estimated_travel_time_seconds,
      route_source = excluded.route_source,
      route_status = excluded.route_status,
      fetched_at = CURRENT_TIMESTAMP,
      expires_at = excluded.expires_at
  `).run(
    first.id, second.id, route.straightLineDistanceKm, route.roadDistanceKm,
    route.estimatedTravelTimeSeconds, route.routeSource, route.routeStatus, expiresAt,
  );
  return db.prepare('SELECT * FROM camera_routes WHERE from_camera_id = ? AND to_camera_id = ?')
    .get(first.id, second.id);
}

async function recalculateRoutes(cameras, options = {}) {
  const db = options.db || getDb();
  const results = [];
  for (const first of cameras) {
    for (const second of cameras) {
      if (first.id === second.id) continue;
      results.push(await getOrCreateRoute(first, second, { db, forceRefresh: true }));
    }
  }
  return results;
}

module.exports = {
  validCoordinate,
  haversineKm,
  getOrCreateRoute,
  recalculateRoutes,
};