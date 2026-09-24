// ==============================================================================
// VisionTrack — Track-Level Temporal ANPR Confirmation Engine
//
// Fuses multiple OCR observations across consecutive video/stream frames
// for a single physically tracked vehicle.
//
// States:
//   - NO_VALID_PLATE:      No valid plate string detected across all observations
//   - OBSERVED:            Valid plate observed on 1 frame, waiting for multi-frame confirmation
//   - NEEDS_CONFIRMATION:  Conflicting reads or low-confidence observations
//   - TRACK_CONFIRMED:     Multi-frame consensus reached with sufficient evidence
//
// Note on Model Confidence:
//   Softmax output probabilities represent internal model prediction likelihood,
//   NOT empirical ground-truth accuracy. Observations are weighted proportionally
//   alongside detector confidence and spatial crop quality without hallucinating
//   unobserved characters.
// ==============================================================================

const {
  normalizePlateText,
  isIndianPlateFormat,
  isStandardPlateFormat,
} = require('./plateNormalizer');

const CONFIRMATION_STATES = Object.freeze({
  NO_VALID_PLATE: 'NO_VALID_PLATE',
  OBSERVED: 'OBSERVED',
  NEEDS_CONFIRMATION: 'NEEDS_CONFIRMATION',
  TRACK_CONFIRMED: 'TRACK_CONFIRMED',
});

/**
 * Format confidence consistently as a percentage string (e.g. 0.8246 -> "82.46%")
 * Guards against the common bug of multiplying an already-scaled percentage by 100.
 *
 * @param {number|null|undefined} val
 * @param {number} [decimals=2]
 * @returns {string} e.g. "82.46%"
 */
function formatConfidencePercent(val, decimals = 2) {
  if (val == null || Number.isNaN(Number(val))) return '0.00%';
  const num = Number(val);
  // If in range (0, 1], scale up. If already > 1 (e.g. 82.46), keep as is.
  const pct = (num > 0 && num <= 1) ? num * 100 : num;
  return `${pct.toFixed(decimals)}%`;
}

/**
 * Normalize an arbitrary confidence value to [0.0, 1.0]
 *
 * @param {number|null|undefined} val
 * @param {number} [defaultVal=0]
 * @returns {number}
 */
function normalizeConfidenceToUnit(val, defaultVal = 0) {
  if (val == null || Number.isNaN(Number(val))) return defaultVal;
  const num = Number(val);
  if (num > 1.0) {
    return Math.max(0, Math.min(1.0, num / 100.0));
  }
  return Math.max(0, Math.min(1.0, num));
}

/**
 * Estimate spatial crop quality from bounding box dimensions and aspect ratio
 *
 * @param {object} [bbox] - { x, y, width, height }
 * @returns {number} Quality score in range [0.3, 1.0]
 */
function computeCropQuality(bbox) {
  if (!bbox || typeof bbox.width !== 'number' || typeof bbox.height !== 'number') {
    return 0.5;
  }
  const { width, height } = bbox;
  const aspect = height > 0 ? width / height : 0;

  // Standard plates typically have aspect ratio between 2.0 and 5.5
  const isHealthyAspect = aspect >= 1.6 && aspect <= 5.8;
  const isHealthySize = width >= 50 && height >= 14;

  if (isHealthySize && isHealthyAspect) return 1.0;
  if (width >= 35 && height >= 10) return 0.75;
  if (width >= 20) return 0.5;
  return 0.3;
}

/**
 * Construct an observation record for a single frame
 *
 * @param {object} input - { plate, rawPlate, ocrText, confidence, ocrConfidence, plateConfidence, detectorConfidence, bbox, vehicleType }
 * @param {object} [frameContext] - { frameIndex, timestamp, frameBuffer }
 * @returns {object} Clean observation record
 */
function createObservation(input = {}, frameContext = {}) {
  const rawPlate = String(input.rawPlate || input.ocrText || input.plate || '').trim();
  const ocrConf = normalizeConfidenceToUnit(input.ocrConfidence ?? input.confidence, 0);
  const detConf = normalizeConfidenceToUnit(input.detectorConfidence ?? input.plateConfidence ?? input.plate_confidence, 0.8);
  const cropQuality = computeCropQuality(input.plateBbox || input.bbox);
  const frameNumber = Number(frameContext.frameIndex ?? input.frameNumber ?? 0);
  const frameTimestamp = String(frameContext.timestamp || input.timestamp || new Date().toISOString());

  // Normalize using existing normalizer
  const normResult = normalizePlateText(rawPlate);
  const normalizedPlate = normResult.plate || null;
  const isIndian = isIndianPlateFormat(normalizedPlate);
  const isStandard = isStandardPlateFormat(normalizedPlate);
  const isValid = Boolean(normalizedPlate && (isIndian || isStandard));

  // Compute observation weight:
  // 40% OCR confidence + 35% Detector confidence + 15% Crop quality + 10% Format validity
  let weight = 0;
  if (isValid) {
    const formatBonus = isIndian ? 1.0 : 0.8;
    weight = Number((ocrConf * 0.40 + detConf * 0.35 + cropQuality * 0.15 + formatBonus * 0.10).toFixed(4));
  }

  return {
    rawPlate,
    normalizedPlate,
    ocrConfidence: Number(ocrConf.toFixed(4)),
    plateDetectorConfidence: Number(detConf.toFixed(4)),
    cropQuality: Number(cropQuality.toFixed(2)),
    weight,
    isValid,
    frameNumber,
    frameTimestamp,
    frameBuffer: frameContext.frameBuffer || input.frameBuffer || null,
    vehicleType: input.vehicleType || 'vehicle',
    corrections: normResult.corrections || [],
  };
}

/**
 * Perform character-level positional consensus voting across observations.
 * Resolves single-character glyph ambiguities (e.g. 8 vs 0, 4 vs 2, 6 vs 2).
 *
 * @param {Array<object>} observations
 * @returns {string|null} Consensus plate or null if insufficient data
 */
function buildConsensusPlate(observations = []) {
  const validObs = observations.filter(o => o && (o.normalizedPlate || o.rawPlate) && (o.normalizedPlate || o.rawPlate).length >= 6);
  if (validObs.length < 2) return null;

  // Find dominant plate length (typically 9 or 10 characters for Indian plates)
  const lengthCounts = new Map();
  for (const o of validObs) {
    const len = o.normalizedPlate ? o.normalizedPlate.length : o.rawPlate.length;
    if (len >= 8 && len <= 11) {
      lengthCounts.set(len, (lengthCounts.get(len) || 0) + 1);
    }
  }

  let targetLength = 10;
  let maxCount = 0;
  for (const [len, count] of lengthCounts.entries()) {
    if (count > maxCount) {
      maxCount = count;
      targetLength = len;
    }
  }

  // Positional vote matrix: pos -> char -> weighted sum
  const posVotes = Array.from({ length: targetLength }, () => new Map());

  for (const o of validObs) {
    const text = (o.normalizedPlate || o.rawPlate).toUpperCase().replace(/[^A-Z0-9]/g, '');
    const w = o.weight || o.ocrConfidence || 0.5;

    for (let i = 0; i < Math.min(text.length, targetLength); i++) {
      const ch = text[i];
      const votes = posVotes[i];
      votes.set(ch, (votes.get(ch) || 0) + w);
    }
  }

  let consensus = '';
  for (let i = 0; i < targetLength; i++) {
    const votes = posVotes[i];
    if (votes.size === 0) return null;
    let winningChar = '';
    let maxVote = -1;
    for (const [ch, v] of votes.entries()) {
      if (v > maxVote) {
        maxVote = v;
        winningChar = ch;
      }
    }
    consensus += winningChar;
  }

  const norm = normalizePlateText(consensus);
  return norm.plate || consensus;
}

function editDistance(a, b) {
  if (a === b) return 0;
  if (!a || !b) return (a || b).length;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > 3) return Math.max(la, lb);
  const dp = Array.from({ length: la + 1 }, (_, i) => i);
  for (let j = 1; j <= lb; j++) {
    let prev = dp[0];
    dp[0] = j;
    for (let i = 1; i <= la; i++) {
      const temp = dp[i];
      dp[i] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[i], dp[i - 1]);
      prev = temp;
    }
  }
  return dp[la];
}

/**
 * Evaluate all accumulated observations for a tracked vehicle and decide
 * temporal confirmation state, authoritative plate, and evidence metrics.
 *
 * @param {Array<object>} observations
 * @returns {object}
 */
function evaluateTrackObservations(observations = []) {
  if (!observations || observations.length === 0) {
    return {
      state: CONFIRMATION_STATES.NO_VALID_PLATE,
      confirmedPlate: null,
      authoritativeReading: null,
      confidence: 0,
      agreementCount: 0,
      totalObservations: 0,
      validObservations: 0,
      margin: 0,
      shouldSkipOcr: false,
      candidates: [],
    };
  }

  const validObs = observations.filter(o => o.isValid && Boolean(o.normalizedPlate));

  if (validObs.length === 0) {
    return {
      state: CONFIRMATION_STATES.NO_VALID_PLATE,
      confirmedPlate: null,
      authoritativeReading: observations[0] || null,
      confidence: 0,
      agreementCount: 0,
      totalObservations: observations.length,
      validObservations: 0,
      margin: 0,
      shouldSkipOcr: false,
      candidates: [],
    };
  }

  // Aggregate by normalized plate string
  const candidateMap = new Map();

  // If multiple observations exist, also test positional consensus plate
  const consensusPlate = buildConsensusPlate(validObs);
  if (consensusPlate && (isIndianPlateFormat(consensusPlate) || isStandardPlateFormat(consensusPlate))) {
    if (!candidateMap.has(consensusPlate)) {
      candidateMap.set(consensusPlate, {
        plate: consensusPlate,
        count: 0,
        totalWeight: 0,
        ocrConfSum: 0,
        detConfSum: 0,
        maxOcrConf: 0,
        observations: [],
        bestObservation: null,
        highestObsWeight: -1,
        isConsensusPlate: true,
      });
    }
  }

  for (const obs of validObs) {
    const plateKey = obs.normalizedPlate;
    if (!candidateMap.has(plateKey)) {
      candidateMap.set(plateKey, {
        plate: plateKey,
        count: 0,
        totalWeight: 0,
        ocrConfSum: 0,
        detConfSum: 0,
        maxOcrConf: 0,
        observations: [],
        bestObservation: null,
        highestObsWeight: -1,
      });
    }

    const c = candidateMap.get(plateKey);
    c.exactCount = (c.exactCount || 0) + 1;
    c.count += 1;
    c.totalWeight += obs.weight;
    c.ocrConfSum += obs.ocrConfidence;
    c.detConfSum += obs.plateDetectorConfidence;
    if (obs.ocrConfidence > c.maxOcrConf) {
      c.maxOcrConf = obs.ocrConfidence;
    }
    c.observations.push(obs);

    // Pick best observation based on highest OCR confidence and crop quality
    const obsScore = (obs.ocrConfidence * 0.7) + (obs.cropQuality * 0.3);
    const prevBestScore = c.bestObservation ? ((c.bestObservation.ocrConfidence * 0.7) + (c.bestObservation.cropQuality * 0.3)) : -1;
    if (obsScore > prevBestScore) {
      c.highestObsWeight = obs.weight;
      c.bestObservation = obs;
    }

    // Only corroborate consensus plate if this observation is actually close (edit distance <= 2 or prefix/suffix)
    if (consensusPlate && candidateMap.has(consensusPlate) && plateKey !== consensusPlate) {
      const isClose = (plateKey.length >= 6 && consensusPlate.startsWith(plateKey)) ||
                      (consensusPlate.length >= 6 && plateKey.startsWith(consensusPlate)) ||
                      (editDistance(plateKey, consensusPlate) <= 2);
      if (isClose) {
        const cons = candidateMap.get(consensusPlate);
        cons.count += 0.8;
        cons.totalWeight += obs.weight * 0.9;
        cons.ocrConfSum += obs.ocrConfidence * 0.9;
        cons.detConfSum += obs.plateDetectorConfidence * 0.9;
        if (obs.ocrConfidence > cons.maxOcrConf) cons.maxOcrConf = obs.ocrConfidence;
        if (!cons.bestObservation || obs.weight > cons.highestObsWeight) {
          cons.highestObsWeight = obs.weight;
          cons.bestObservation = obs;
        }
        cons.observations.push(obs);
      }
    }
  }

  // Calculate composite agreement score for each candidate
  // Repeated observations over time confirm the reading.
  // CRITICAL RULE: Among competing candidates with reasonably similar confidence,
  // a LONGER, more complete valid-format match is preferred over a shorter/truncated
  // one that just happened to repeat more often (e.g. TS09UA2646 vs TS09UA26 or TS09UA264).
  const rawCandidateList = Array.from(candidateMap.values()).map(c => {
    const avgOcrConf = c.count > 0 ? c.ocrConfSum / c.count : 0;
    const avgDetConf = c.count > 0 ? c.detConfSum / c.count : 0;
    return {
      plate: c.plate,
      count: c.count,
      totalWeight: Number(c.totalWeight.toFixed(4)),
      avgOcrConf: Number(avgOcrConf.toFixed(4)),
      avgDetConf: Number(avgDetConf.toFixed(4)),
      maxOcrConf: Number(c.maxOcrConf.toFixed(4)),
      bestObservation: c.bestObservation,
      observations: c.observations,
    };
  });

  const candidates = rawCandidateList.map(c => {
    let score = c.totalWeight + (c.count - 1) * 0.45;

    // Completeness bonus for standard 9-10 character Indian registrations
    const isFullIndian = /^[A-Z]{2}\d{2}[A-Z]{1,2}\d{4}$/.test(c.plate);
    if (isFullIndian && c.avgOcrConf >= 0.55) {
      score += 1.25;
    }

    let corroboratingCount = 0;
    // Check if other shorter candidates are prefixes/sub-readings of this candidate
    for (const other of rawCandidateList) {
      if (other === c) continue;
      const isPrefix = other.plate.length < c.plate.length && c.plate.startsWith(other.plate);
      if (isPrefix) {
        // If this candidate has solid confidence (within 20% of other, or >= 70%)
        const confOk = c.maxOcrConf >= 0.70 || c.avgOcrConf >= other.avgOcrConf - 0.20;
        if (confOk) {
          // The other observations corroborate this candidate's prefix!
          score += other.totalWeight * 0.85 + (other.count * 0.25);
          corroboratingCount += other.count;
        }
      }
    }

    return {
      ...c,
      corroboratingCount,
      effectiveCount: c.count + corroboratingCount,
      agreementScore: Number(score.toFixed(4)),
    };
  });

  // Sort descending by agreement score
  candidates.sort((a, b) => b.agreementScore - a.agreementScore);

  const top = candidates[0];
  const runnerUp = candidates.length > 1 ? candidates[1] : null;

  // Measure separation margin against the closest competitor
  let margin = 1.0;
  if (runnerUp && top.agreementScore > 0) {
    margin = Number(((top.agreementScore - runnerUp.agreementScore) / top.agreementScore).toFixed(4));
  }

  // When checking for conflict against runnerUp:
  // If runnerUp is a truncated prefix of top (or vice-versa), they are NOT in conflict!
  const isPrefixRelation = runnerUp && (
    (runnerUp.plate.length < top.plate.length && top.plate.startsWith(runnerUp.plate)) ||
    (top.plate.length < runnerUp.plate.length && runnerUp.plate.startsWith(top.plate))
  );

  let state = CONFIRMATION_STATES.OBSERVED;
  let shouldSkipOcr = false;

  // Decision logic:
  // 1. Conflicting valid reads with close scores (margin < 0.25 and runnerUp has similar count)
  if (runnerUp && !isPrefixRelation && margin < 0.25 && runnerUp.count >= top.count - 1 && runnerUp.totalWeight >= 0.5) {
    state = CONFIRMATION_STATES.NEEDS_CONFIRMATION;
  }
  // 2. Multi-frame confirmation: at least 2 agreeing/corroborated frames with adequate confidence
  else if (top.effectiveCount >= 2 && top.maxOcrConf >= 0.60 && (top.totalWeight >= 0.80 || top.effectiveCount >= 3)) {
    state = CONFIRMATION_STATES.TRACK_CONFIRMED;
    // Skip repeated OCR once confirmed with solid confidence across at least 2 agreeing frames
    if (top.effectiveCount >= 2 && top.avgOcrConf >= 0.65) {
      shouldSkipOcr = true;
    }
  }
  // 3. Single-frame observation: do NOT lock or skip OCR on a single frame!
  // Allow approaching vehicle to accumulate 2-3 observations so the best frame is compared.
  else if (top.count === 1 && (
    (top.maxOcrConf >= 0.85 && (isIndianPlateFormat(top.plate) || isStandardPlateFormat(top.plate))) ||
    (top.maxOcrConf >= 0.80 && top.avgDetConf >= 0.80 && (margin >= 0.8 || isPrefixRelation))
  )) {
    state = CONFIRMATION_STATES.OBSERVED;
    shouldSkipOcr = false; // Never skip on single frame; allow 2-3 frames to compare
  }
  // 4. Low-confidence observation (under 40% OCR)
  else if (top.maxOcrConf < 0.40 || top.totalWeight < 0.35) {
    state = CONFIRMATION_STATES.NEEDS_CONFIRMATION;
  }
  // 5. Standard single-frame observation
  else {
    state = CONFIRMATION_STATES.OBSERVED;
  }

  const authoritativeReading = top.bestObservation || validObs[0];

  // Composite normalized confidence score for downstream consumers [0.0 - 1.0]
  const compositeConfidence = Number(
    Math.min(0.999, Math.max(0.1, (top.avgOcrConf * 0.55 + top.avgDetConf * 0.25 + (top.count > 1 ? 0.20 : 0.05)))).toFixed(4)
  );

  return {
    state,
    confirmedPlate: state === CONFIRMATION_STATES.TRACK_CONFIRMED ? top.plate : null,
    candidatePlate: top.plate,
    confidence: compositeConfidence,
    confidencePercent: formatConfidencePercent(compositeConfidence),
    agreementCount: top.exactCount || Math.floor(top.count),
    totalObservations: observations.length,
    validObservations: validObs.length,
    margin,
    shouldSkipOcr,
    authoritativeReading,
    topCandidate: top,
    candidates,
  };
}

module.exports = {
  CONFIRMATION_STATES,
  formatConfidencePercent,
  normalizeConfidenceToUnit,
  computeCropQuality,
  createObservation,
  evaluateTrackObservations,
};
