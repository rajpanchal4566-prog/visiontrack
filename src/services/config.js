const configuredApiUrl = import.meta.env.VITE_API_URL;
const configuredApiOrigin = configuredApiUrl
  ? configuredApiUrl.replace(/\/api\/?$/, '')
  : window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
    ? `http://${window.location.hostname}:3001`
    : window.location.origin;

export const API_ORIGIN = configuredApiOrigin.replace(/\/$/, '');
export const API_BASE = `${API_ORIGIN}/api`;
