// ============================================
// VisionTrack — REST API Client
// With JWT Authentication Headers
// ============================================
import { API_BASE } from './config';

function getAuthHeaders() {
  const token = localStorage.getItem('anpr_token');
  if (token) {
    return { 'Authorization': `Bearer ${token}` };
  }
  return {};
}

async function fetchApi(endpoint, options = {}) {
  try {
    const response = await fetch(`${API_BASE}${endpoint}`, {
      headers: {
        'Content-Type': 'application/json',
        ...getAuthHeaders(),
        ...options.headers,
      },
      ...options,
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Request failed' }));
      throw new Error(error.error || `HTTP ${response.status}`);
    }
    return response.json();
  } catch (err) {
    console.error(`API Error [${endpoint}]:`, err.message);
    throw err;
  }
}

// --- Auth ---
export const authApi = {
  login: (email, password) => fetchApi('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  }),
  register: (data) => fetchApi('/auth/register', {
    method: 'POST',
    body: JSON.stringify(data),
  }),
  me: () => fetchApi('/auth/me'),
};

// --- Cameras ---
export const camerasApi = {
  getAll: (city) => fetchApi(`/cameras${city ? `?city=${encodeURIComponent(city)}` : ''}`),
  getCities: () => fetchApi('/cameras/cities'),
  getById: (id) => fetchApi(`/cameras/${id}`),
  getPresets: () => fetchApi('/cameras/presets'),
  testStream: (url, transport = 'tcp') => fetchApi('/cameras/test-stream', {
    method: 'POST', body: JSON.stringify({ url, transport }),
  }),
  updateStatus: (id, status) => fetchApi(`/cameras/${id}`, {
    method: 'PUT', body: JSON.stringify({ status }),
  }),
  updateConfig: (id, config) => fetchApi(`/cameras/${encodeURIComponent(id)}`, {
    method: 'PUT', body: JSON.stringify(config),
  }),
  register: (data) => fetchApi('/cameras/register', {
    method: 'POST', body: JSON.stringify(data),
  }),
  create: (data) => fetchApi('/cameras', {
    method: 'POST', body: JSON.stringify(data),
  }),
  getConnections: (id) => fetchApi(`/cameras/${encodeURIComponent(id)}/connections`),
  getRoutes: (id) => fetchApi(`/cameras/${encodeURIComponent(id)}/routes`),
  recalculateRoutes: () => fetchApi('/cameras/routes/recalculate', { method: 'POST' }),
  connectStream: (id, url, options = {}) => fetchApi(`/cameras/${encodeURIComponent(id)}/connect-stream`, {
    method: 'POST', body: JSON.stringify({ url, ...options }),
  }),
  disconnectStream: (id) => fetchApi(`/cameras/${encodeURIComponent(id)}/disconnect-stream`, { method: 'POST' }),
  getStreamsStatus: () => fetchApi('/cameras/streams/status'),
  connectAllStreams: () => fetchApi('/cameras/streams/connect-all', { method: 'POST' }),
  disconnectAllStreams: () => fetchApi('/cameras/streams/disconnect-all', { method: 'POST' }),
};

export const organizationsApi = {
  getAll: () => fetchApi('/organizations'),
  getKey: (id) => fetchApi(`/organizations/${encodeURIComponent(id)}/key`),
  generateLinkKey: (id) => fetchApi(`/organizations/${encodeURIComponent(id)}/generate-link-key`, { method: 'POST' }),
  connectToSuperadmin: (id, data) => fetchApi(`/organizations/${encodeURIComponent(id)}/connect-to-superadmin`, {
    method: 'POST', body: JSON.stringify(data),
  }),
  disconnectSuperadmin: (id) => fetchApi(`/organizations/${encodeURIComponent(id)}/disconnect-superadmin`, { method: 'POST' }),
  getChildren: (id) => fetchApi(`/organizations/${encodeURIComponent(id)}/children`),
};

// --- Detections ---
export const detectionsApi = {
  getById: (id) => fetchApi(`/detections/${encodeURIComponent(id)}`),
  getReport: async (id) => {
    const response = await fetch(`${API_BASE}/detections/${encodeURIComponent(id)}/report`, {
      headers: getAuthHeaders(),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Report request failed' }));
      throw new Error(error.error || `HTTP ${response.status}`);
    }
    return response.blob();
  },
  getAll: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return fetchApi(`/detections?${qs}`);
  },
  getLatest: (limit = 20) => fetchApi(`/detections/latest?limit=${limit}`),
  getStats: () => fetchApi('/detections/stats'),
  getFlagged: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return fetchApi(`/detections/flagged${qs ? `?${qs}` : ''}`);
  },
};

// --- Vehicles ---
export const vehiclesApi = {
  search: (plate) => fetchApi(`/vehicles/search?plate=${encodeURIComponent(plate)}`),
  getTrajectory: (plate) => fetchApi(`/vehicles/${encodeURIComponent(plate)}/trajectory`),
  getHistory: (plate) => fetchApi(`/vehicles/${encodeURIComponent(plate)}/history`),
};

export const travelApi = {
  getValidations: (params = {}) => fetchApi(`/travel-validations?${new URLSearchParams(params).toString()}`),
  getFlaggedVehicles: (params = {}) => fetchApi(`/flagged-vehicles?${new URLSearchParams(params).toString()}`),
  updateFlaggedVehicle: (id, status) => fetchApi(`/flagged-vehicles/${id}`, { method: 'PUT', body: JSON.stringify({ status }) }),
  getSettings: () => fetchApi('/settings'),
  updateSettings: (data) => fetchApi('/settings', { method: 'PUT', body: JSON.stringify(data) }),
};

// --- Watchlist ---
export const watchlistApi = {
  getAll: (type) => fetchApi(`/watchlist${type ? `?type=${type}` : ''}`),
  add: (data) => fetchApi('/watchlist', {
    method: 'POST', body: JSON.stringify(data),
  }),
  remove: (id) => fetchApi(`/watchlist/${id}`, { method: 'DELETE' }),
};

// --- Alerts ---
export const alertsApi = {
  getAll: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return fetchApi(`/alerts?${qs}`);
  },
  getStats: () => fetchApi('/alerts/stats'),
  resolve: (id) => fetchApi(`/alerts/${id}/resolve`, { method: 'PUT' }),
};

// --- Analytics ---
export const analyticsApi = {
  getTraffic: (date) => fetchApi(`/analytics/traffic${date ? `?date=${date}` : ''}`),
  getHeatmap: (date) => fetchApi(`/analytics/heatmap${date ? `?date=${date}` : ''}`),
  getCongestion: () => fetchApi('/analytics/congestion'),
  getVehicleTypes: (date) => fetchApi(`/analytics/vehicle-types${date ? `?date=${date}` : ''}`),
  getComparison: (date1, date2) => fetchApi(`/analytics/comparison?date1=${date1}&date2=${date2}`),
  getZoneTraffic: (date) => fetchApi(`/analytics/zone-traffic${date ? `?date=${date}` : ''}`),
  getCameraTraffic: (cameraId, date) => fetchApi(`/analytics/camera-traffic?${new URLSearchParams({ ...(cameraId ? { camera_id: cameraId } : {}), ...(date ? { date } : {}) }).toString()}`),
  getDaySummary: (date) => fetchApi(`/analytics/day-summary?date=${date}`),
  getDayOverDay: () => fetchApi('/analytics/day-over-day'),
};

// --- Decode / Flagging ---
export const decodeApi = {
  decode: (jsonData) => fetchApi('/decode', {
    method: 'POST', body: JSON.stringify(jsonData),
  }),
  getLog: (limit = 50) => fetchApi(`/decode/log?limit=${limit}`),
  getFlags: (type) => fetchApi(`/decode/flags${type ? `?type=${type}` : ''}`),
  addFlag: (data) => fetchApi('/decode/flags', {
    method: 'POST', body: JSON.stringify(data),
  }),
  removeFlag: (id) => fetchApi(`/decode/flags/${id}`, { method: 'DELETE' }),
  updateFlag: (id, data) => fetchApi(`/decode/flags/${id}`, {
    method: 'PUT', body: JSON.stringify(data),
  }),
  bulkImport: (data) => fetchApi('/decode/flags/bulk', {
    method: 'POST', body: JSON.stringify(data),
  }),
};

// --- Health ---
export const healthApi = {
  check: () => fetchApi('/health'),
};

// --- OCR ---
export const ocrApi = {
  test: async (formData) => {
    const token = localStorage.getItem('anpr_token');
    const headers = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const response = await fetch(`${API_BASE}/ocr/test`, {
      method: 'POST',
      headers,
      body: formData,
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Request failed' }));
      throw new Error(error.error || `HTTP ${response.status}`);
    }
    return response.json();
  },
  status: () => fetchApi('/ocr/status'),
};

// --- Media & Video Jobs ---
export const mediaApi = {
  getVideoJobs: () => fetchApi('/video/jobs'),
  getVideoJob: (id) => fetchApi(`/video/jobs/${encodeURIComponent(id)}`),
  uploadVideoJob: async (formData) => {
    const token = localStorage.getItem('anpr_token');
    const headers = token ? { 'Authorization': `Bearer ${token}` } : {};
    const res = await fetch(`${API_BASE}/video/jobs`, {
      method: 'POST',
      headers,
      body: formData,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Upload failed' }));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    return res.json();
  },
  startVideoJob: (id) => fetchApi(`/video/jobs/${encodeURIComponent(id)}/start`, { method: 'POST' }),
  stopVideoJob: (id) => fetchApi(`/video/jobs/${encodeURIComponent(id)}/stop`, { method: 'POST' }),
};
