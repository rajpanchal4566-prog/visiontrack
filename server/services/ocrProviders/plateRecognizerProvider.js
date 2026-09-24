const PLATE_RECOGNIZER_URL = 'https://api.platerecognizer.com/v1/plate-reader/';

function normalizedConfidence(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return numeric > 1 ? Math.min(1, numeric / 100) : Math.max(0, Math.min(1, numeric));
}

async function recognizeWithPlateRecognizer(imageBuffer, options = {}) {
  if (String(process.env.PLATE_RECOGNIZER_ENABLED || 'true').toLowerCase() === 'false') {
    return {
      success: false,
      configured: false,
      error: 'Plate Recognizer is disabled',
      status: 'DISABLED',
      plate: null,
      confidence: 0,
    };
  }
  const token = String(process.env.PLATE_RECOGNIZER_TOKEN || '').trim();
  if (!token) {
    return {
      success: false,
      configured: false,
      error: 'PLATE_RECOGNIZER_TOKEN is not configured',
      status: 'NOT_CONFIGURED',
      plate: null,
      confidence: 0,
    };
  }

  if (!Buffer.isBuffer(imageBuffer) || imageBuffer.length === 0) {
    return {
      success: false,
      configured: true,
      error: 'A non-empty image buffer is required',
      status: 'INVALID_IMAGE',
      plate: null,
      confidence: 0,
    };
  }

  const form = new FormData();
  form.append('upload', new Blob([imageBuffer], { type: options.mimeType || 'image/png' }), 'plate.png');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(options.timeoutMs) || 15000);

  try {
    const response = await fetch(PLATE_RECOGNIZER_URL, {
      method: 'POST',
      headers: { Authorization: `Token ${token}` },
      body: form,
      signal: controller.signal,
    });

    const body = await response.json().catch(() => null);
    if (!response.ok) {
      return {
        success: false,
        configured: true,
        error: body?.detail || body?.message || `Plate Recognizer HTTP ${response.status}`,
        status: response.status === 401 ? 'INVALID_TOKEN' : response.status === 429 ? 'RATE_LIMITED' : 'HTTP_ERROR',
        httpStatus: response.status,
        plate: null,
        confidence: 0,
      };
    }

    const result = Array.isArray(body?.results) ? body.results[0] : null;
    if (!result?.plate) {
      return {
        success: false,
        configured: true,
        error: 'Plate Recognizer found no plate',
        status: 'NO_PLATE_FOUND',
        plate: null,
        confidence: 0,
        raw: body,
      };
    }

    const vehicle = result.vehicle || {};
    return {
      success: true,
      configured: true,
      status: 'SUCCESS',
      plate: String(result.plate).toUpperCase().replace(/[^A-Z0-9]/g, ''),
      confidence: normalizedConfidence(result.score),
      box: result.box || null,
      vehicleType: vehicle.type || null,
      raw: body,
    };
  } catch (error) {
    return {
      success: false,
      configured: true,
      error: error.name === 'AbortError' ? 'Plate Recognizer request timed out' : error.message,
      status: error.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK_ERROR',
      plate: null,
      confidence: 0,
    };
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { recognizeWithPlateRecognizer };
