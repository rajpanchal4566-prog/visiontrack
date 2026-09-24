const VIOLATION_LABELS = {
  no_helmet: 'No helmet',
  no_seatbelt: 'No seatbelt',
};

function valuesFrom(body, keys) {
  return keys.flatMap(key => {
    const value = body?.[key];
    if (value === undefined || value === null || value === '') return [];
    return Array.isArray(value) ? value : [value];
  });
}

function truthy(value) {
  return value === true || value === 1 || value === '1' || String(value).toLowerCase() === 'true';
}

function addViolation(found, value, allowGeneric = false) {
  if (value === undefined || value === null) return;
  const text = String(value).trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (text.includes('helmet') && (text.includes('no_') || text.includes('without') || text.includes('missing') || text.includes('not_wearing'))) {
    found.add('no_helmet');
  }
  if (text.includes('seatbelt') || text.includes('seat_belt')) {
    if (text.includes('no_') || text.includes('without') || text.includes('missing') || text.includes('not_wearing')) found.add('no_seatbelt');
  }
  if (Object.prototype.hasOwnProperty.call(VIOLATION_LABELS, text)) found.add(text);
  else if (allowGeneric && !['none', 'normal', 'ok', 'plate_read'].includes(text)) found.add(text);
}

function investigateDetection(input = {}, context = {}) {
  const found = new Set();
  const explicit = valuesFrom(input, [
    'violations', 'violation', 'violation_type', 'violationType', 'offences', 'offense',
    'offence', 'infractions', 'traffic_violations', 'alerts', 'event_type', 'eventType',
    'violation_tag', 'violation_tags',
  ]);
  explicit.forEach(value => {
    if (typeof value === 'object') {
      addViolation(found, value.type || value.name || value.label || value.code, true);
    } else {
      addViolation(found, value, true);
    }
  });

  const helmetSignals = valuesFrom(input, ['no_helmet', 'noHelmet', 'helmet_missing', 'helmetMissing']);
  const seatbeltSignals = valuesFrom(input, ['no_seatbelt', 'noSeatbelt', 'seatbelt_missing', 'seatbeltMissing']);
  if (helmetSignals.some(truthy)) found.add('no_helmet');
  if (seatbeltSignals.some(truthy)) found.add('no_seatbelt');
  if (input.helmet_detected === false || input.helmetDetected === false || input.has_helmet === false) found.add('no_helmet');
  if (input.seatbelt_detected === false || input.seatbeltDetected === false || input.has_seatbelt === false) found.add('no_seatbelt');

  // Camera/edge AI can send object attributes alongside the image. Treat those
  // annotations as the investigation input without pretending OCR alone is vision analysis.
  valuesFrom(input, ['objects', 'attributes', 'ai_results', 'aiResults', 'analysis']).forEach(value => {
    if (Array.isArray(value)) value.forEach(item => addViolation(found, item?.label || item?.name || item?.class || item?.type));
    else if (typeof value === 'object') Object.entries(value).forEach(([key, item]) => {
      if (truthy(item) && /helmet|seat.?belt/i.test(key)) addViolation(found, `no_${key}`);
      addViolation(found, item?.label || item?.name || item?.class || item?.type);
    });
  });

  const violations = [...found].map(code => ({ code, label: VIOLATION_LABELS[code] || code.replace(/_/g, ' ') }));
  const imageReceived = Boolean(context.imagePath || input.image || input.image_url || input.snapshot || input.picture);
  return {
    violations,
    flagged: violations.length > 0,
    source: violations.length > 0 ? 'investigation' : null,
    status: imageReceived ? 'analyzed' : 'metadata_only',
    confidence: violations.length > 0 ? 1 : 0,
  };
}

module.exports = { investigateDetection };
