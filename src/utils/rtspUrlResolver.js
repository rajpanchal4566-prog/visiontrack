/**
 * RTSP / Stream URL Resolver (Frontend)
 * 
 * Ensures custom RTSP and HTTP URLs are preserved exactly as entered without
 * unwanted prefixing (e.g. http://) or suffixing (e.g. /video).
 */

export function resolveRtspUrl(input, options = {}) {
  // Direct string input handling (e.g. resolveRtspUrl('rtsp://192.168.1.23:8554'))
  if (typeof input === 'string') {
    return input.trim();
  }

  const config = input || {};
  const {
    selectedPreset,
    customUrl,
    ip = '',
    port = '',
    username = '',
    password = '',
    path = '',
  } = config;

  // 1. Custom URL selection or explicit customUrl provided:
  // Preserve the exact user-entered URL. Do not prepend http:// or append /video.
  if (selectedPreset === 'custom' || customUrl) {
    return (customUrl || '').trim();
  }

  const rawIp = (ip || '').trim();

  // 4. If the IP/URL begins with rtsp:// or rtsps://, pass it unchanged
  if (/^rtsps?:\/\//i.test(rawIp)) {
    return rawIp;
  }

  // Preset-based generation for known camera manufacturers
  const presets = options.presets || [];
  const preset = presets.find(p => p.id === selectedPreset);
  const host = rawIp || '192.168.1.100';
  const resolvedPort = port || (preset?.port ? String(preset.port) : '554');
  const auth = username ? `${encodeURIComponent(username)}:${encodeURIComponent(password || '')}@` : '';

  if (preset) {
    return preset.template
      .replace('[username]:[password]@', auth)
      .replace('[ip]', host)
      .replace(':554', `:${resolvedPort}`)
      .replace(':8080', `:${resolvedPort}`)
      .replace(':8554', `:${resolvedPort}`)
      .replace(':4747', `:${resolvedPort}`);
  }

  const cleanPath = (path || '').replace(/^\//, '');
  return `rtsp://${auth}${host}:${resolvedPort}/${cleanPath}`;
}
