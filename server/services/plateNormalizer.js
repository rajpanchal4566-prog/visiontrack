// ============================================
// VisionTrack — License Plate Text Normalizer
// Post-processes raw OCR text to produce a
// clean, normalized plate number.
// ============================================

/**
 * Indian license plate format patterns.
 * Used for validation and guiding OCR corrections.
 *
 * Common Indian formats:
 *   MP09AB1234   (state + district + series + number)
 *   MH12DE1433
 *   DL01AB1234
 *   GJ01AA1234
 *   MP09A1234    (older format with single letter series)
 *   TN23L4547
 */
const INDIAN_PLATE_PATTERNS = [
  // Standard: XX00XX0000 (2 letters, 2 digits, 1-2 letters, 1-4 digits)
  /^[A-Z]{2}\d{2}[A-Z]{1,3}\d{1,4}$/,
  // BH-series (Bharat series): 00BH0000XX
  /^\d{2}BH\d{4}[A-Z]{2}$/,
];

const INDIAN_STATE_CODES = new Set([
  'AN', 'AP', 'AR', 'AS', 'BR', 'CH', 'CG', 'DD', 'DL', 'DN', 'GA', 'GJ',
  'HP', 'HR', 'JH', 'JK', 'KA', 'KL', 'LA', 'LD', 'MH', 'ML', 'MN', 'MP',
  'MZ', 'NL', 'OD', 'OR', 'PB', 'PY', 'RJ', 'SK', 'TN', 'TR', 'TS', 'UA',
  'UK', 'UP', 'WB',
]);

const GENERAL_PLATE_PATTERNS = [
  /^[A-Z]{1,3}\d{1,4}[A-Z]{0,3}$/,
  /^[A-Z]{1,3}\d{1,4}$/,
  /^[A-Z]{2}\d{2}[A-Z]{1,3}\d{1,4}$/,
];

function isStandardPlateFormat(plate) {
  if (!plate || typeof plate !== 'string') return false;
  const clean = plate.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (clean.length < 4 || clean.length > 12) return false;
  const letters = (clean.match(/[A-Z]/g) || []).length;
  const digits = (clean.match(/\d/g) || []).length;
  if (letters < 1 || digits < 1) return false;

  // Indian RTO format check: Any plate starting with 2 letters and digits
  // MUST start with an authentic Indian State/UT code (or Bharat series BH)
  // and CANNOT have RTO code '00' (Indian RTO districts begin at 01).
  if (/^[A-Z]{2}\d/.test(clean)) {
    if (!INDIAN_STATE_CODES.has(clean.slice(0, 2))) {
      return false; // Reject invalid state code like "AM", "ZZ", etc.
    }
    if (/^[A-Z]{2}00/.test(clean)) {
      return false; // Reject non-existent RTO district 00
    }
  }

  return isIndianPlateFormat(clean) || GENERAL_PLATE_PATTERNS.some(p => p.test(clean));
}

/**
 * OCR character confusion map — ONLY applied in positional context.
 */
/**
 * OCR character confusion map — ONLY applied in positional context.
 * Covers empirical ANPR confusion pairs:
 *   3 <-> U, 8 <-> 3, 1 <-> 7, T <-> 1/7, 0 <-> 8/3, M <-> N/A/1, F <-> 5/1
 */
const POSITIONAL_LETTER_TO_DIGIT = {
  'O': ['0'],
  'Q': ['0'],
  'D': ['0'],
  'I': ['1'],
  'L': ['1'],
  'J': ['1'],
  'M': ['1'],
  'N': ['1'],
  'Z': ['2'],
  'U': ['3'],
  'E': ['3'],
  'A': ['4', '1'],
  'S': ['5'],
  'F': ['5', '1'],
  'G': ['6'],
  'T': ['7', '1'],
  'B': ['8', '3', '0'],
};

const POSITIONAL_DIGIT_TO_LETTER = {
  '0': ['O', 'D', 'Q'],
  '1': ['I', 'L', 'T', 'M', 'N', 'A', 'F'],
  '2': ['Z'],
  '3': ['U', 'E', 'B'],
  '4': ['A'],
  '5': ['S', 'F'],
  '6': ['G'],
  '7': ['T', 'I', 'L'],
  '8': ['B'],
};

// Legacy scalar lookup maps for single-character fallback
const LETTER_TO_DIGIT = {
  'O': '0', 'Q': '0', 'D': '0', 'I': '1', 'L': '1', 'J': '1',
  'M': '1', 'N': '1', 'Z': '2', 'U': '3', 'E': '3', 'A': '4',
  'S': '5', 'F': '5', 'G': '6', 'T': '7', 'B': '8',
};

const DIGIT_TO_LETTER = {
  '0': 'O', '1': 'I', '2': 'Z', '3': 'U', '4': 'A',
  '5': 'S', '6': 'G', '7': 'T', '8': 'B',
};

/**
 * Clean raw OCR text: uppercase, remove non-alphanumeric, strip whitespace/newlines.
 */
function cleanOcrText(text) {
  if (!text || typeof text !== 'string') return '';
  return text
    .toUpperCase()
    .replace(/[\r\n]+/g, ' ')  // newlines to spaces
    .replace(/[^A-Z0-9\s]/g, '') // remove non-alphanumeric except spaces
    .replace(/\s+/g, '')        // remove all whitespace
    .trim();
}

/**
 * Extract potential plate candidates from OCR text.
 * OCR may return multiple lines or extra characters.
 * We try to find the most plate-like substring.
 */
function extractPlateCandidates(rawText) {
  if (!rawText || typeof rawText !== 'string') return [];

  const candidates = [];

  // Clean the full text as one candidate
  const fullClean = cleanOcrText(rawText);
  if (fullClean.length >= 4 && fullClean.length <= 15) {
    candidates.push(fullClean);
  }

  // Also split by whitespace/newlines and try combinations
  const parts = rawText.toUpperCase().replace(/[^A-Z0-9\s\n\r-]/g, '').split(/[\s\n\r-]+/).filter(p => p.length > 0);

  // Individual parts
  for (const part of parts) {
    const cleaned = part.replace(/[^A-Z0-9]/g, '');
    if (cleaned.length >= 4 && cleaned.length <= 12) {
      candidates.push(cleaned);
    }
  }

  // Concatenated pairs of adjacent parts
  for (let i = 0; i < parts.length - 1; i++) {
    const combined = (parts[i] + parts[i + 1]).replace(/[^A-Z0-9]/g, '');
    if (combined.length >= 6 && combined.length <= 12) {
      candidates.push(combined);
    }
  }

  // All parts concatenated
  if (parts.length > 2) {
    const all = parts.join('').replace(/[^A-Z0-9]/g, '');
    if (all.length >= 6 && all.length <= 15) {
      candidates.push(all);
    }
  }

  // Deduplicate
  const cleanedCandidates = [...new Set(candidates)];
  const windowCandidates = [];
  for (const candidate of cleanedCandidates) {
    for (let length = 8; length <= 12; length += 1) {
      if (candidate.length <= length) continue;
      for (let start = 0; start <= candidate.length - length; start += 1) {
        windowCandidates.push(candidate.slice(start, start + length));
      }
    }
  }

  // OCR often adds a leading/trailing character around an otherwise readable
  // plate. Only anchor these candidates at a known Indian state code.
  for (const candidate of cleanedCandidates) {
    for (const stateCode of INDIAN_STATE_CODES) {
      const stateIndex = candidate.indexOf(stateCode);
      if (stateIndex < 0) continue;
      const anchored = candidate.slice(stateIndex);
      for (let length = 8; length <= 12 && length <= anchored.length; length += 1) {
        windowCandidates.push(anchored.slice(0, length));
      }
    }
  }

  return [...new Set([...cleanedCandidates, ...windowCandidates])];
}

/**
 * Attempt positional character correction for Indian-format plates.
 *
 * Rules:
 * 1. ONLY replace a character if its current type (letter vs digit) MISMATCHES
 *    the expected positional role AND it exists in the known confusion pair list.
 * 2. Do NOT replace characters that ALREADY match their expected type.
 * 3. Only return corrected string if it matches a valid Indian plate format
 *    and authentic Indian state code.
 */
function correctIndianPlate(stripped) {
  if (!stripped || typeof stripped !== 'string') return stripped;
  const clean = stripped.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (clean.length < 6 || clean.length > 12) return clean;

  const chars = clean.split('');
  const N = chars.length;

  function getExpectedTypes(len) {
    const roles = new Array(len).fill('LETTER');
    if (len === 10) {
      roles[0] = 'LETTER'; roles[1] = 'LETTER';
      roles[2] = 'DIGIT';  roles[3] = 'DIGIT';
      roles[4] = 'LETTER'; roles[5] = 'LETTER';
      roles[6] = 'DIGIT';  roles[7] = 'DIGIT'; roles[8] = 'DIGIT'; roles[9] = 'DIGIT';
    } else if (len === 9) {
      roles[0] = 'LETTER'; roles[1] = 'LETTER';
      roles[2] = 'DIGIT';  roles[3] = 'DIGIT';
      roles[4] = 'LETTER';
      roles[5] = 'DIGIT';  roles[6] = 'DIGIT'; roles[7] = 'DIGIT'; roles[8] = 'DIGIT';
    } else if (len === 8) {
      roles[0] = 'LETTER'; roles[1] = 'LETTER';
      roles[2] = 'DIGIT';  roles[3] = 'DIGIT';
      roles[4] = 'LETTER';
      roles[5] = 'DIGIT';  roles[6] = 'DIGIT'; roles[7] = 'DIGIT';
    } else {
      roles[0] = 'LETTER'; roles[1] = 'LETTER';
      if (len > 2) roles[2] = 'DIGIT';
      if (len > 3) roles[3] = 'DIGIT';
      for (let i = Math.max(4, len - 4); i < len; i++) {
        roles[i] = 'DIGIT';
      }
    }
    return roles;
  }

  const expectedTypes = getExpectedTypes(N);
  const positionOptions = [];
  let hasMismatch = false;

  // Indian RTO check: No Indian state has RTO code '00'
  const hasInvalidRto00 = N >= 4 && chars[2] === '0' && chars[3] === '0';

  for (let i = 0; i < N; i++) {
    const currentChar = chars[i];
    const expected = expectedTypes[i];
    const isCharDigit = /\d/.test(currentChar);
    const isCharLetter = /[A-Z]/.test(currentChar);

    // Handle invalid RTO code '00' (common OCR degradation of '09' or '01')
    if (hasInvalidRto00 && (i === 2 || i === 3)) {
      hasMismatch = true;
      if (i === 3) {
        // Telangana (TS), AP, and major states: '00' is overwhelmingly misread '09' or '01'
        positionOptions.push(['9', '1', '8', '0']);
      } else {
        positionOptions.push(['0', '1']);
      }
      continue;
    }

    // Handle MoRTH Rule: Letters 'O' and 'I' are officially omitted from Indian registration series to prevent confusion with 0 and 1.
    if (expected === 'LETTER' && isCharLetter && (i === 4 || i === 5)) {
      if (currentChar === 'I') {
        positionOptions.push(['A', 'T']); // MoRTH excludes 'I'; OCR 'I' in series is overwhelmingly 'A'
        hasMismatch = true;
        continue;
      } else if (currentChar === 'O') {
        positionOptions.push(['D', 'C', 'Q']); // MoRTH excludes 'O'
        hasMismatch = true;
        continue;
      }
    }

    if (expected === 'LETTER' && isCharDigit) {
      const replacements = POSITIONAL_DIGIT_TO_LETTER[currentChar];
      if (replacements && replacements.length > 0) {
        positionOptions.push(replacements);
        hasMismatch = true;
      } else {
        positionOptions.push([currentChar]);
      }
    } else if (expected === 'DIGIT' && isCharLetter) {
      const replacements = POSITIONAL_LETTER_TO_DIGIT[currentChar];
      if (replacements && replacements.length > 0) {
        positionOptions.push(replacements);
        hasMismatch = true;
      } else {
        positionOptions.push([currentChar]);
      }
    } else {
      positionOptions.push([currentChar]);
    }
  }

  if (!hasMismatch) {
    return clean;
  }

  let candidateStrings = [''];
  for (let i = 0; i < N; i++) {
    const opts = positionOptions[i];
    const nextStrings = [];
    for (const prefix of candidateStrings) {
      for (const opt of opts) {
        nextStrings.push(prefix + opt);
      }
    }
    candidateStrings = nextStrings;
    if (candidateStrings.length > 32) {
      candidateStrings = candidateStrings.slice(0, 32);
    }
  }

  let bestCandidate = clean;
  let bestScore = scorePlateCandidate(clean) + scoreStructuralFit(clean);

  for (const cand of candidateStrings) {
    if (cand === clean) continue;
    const prefix = cand.slice(0, 2);
    if (!INDIAN_STATE_CODES.has(prefix) && !cand.includes('BH')) continue;

    const candScore = scorePlateCandidate(cand) + scoreStructuralFit(cand);
    if (candScore > bestScore && (isIndianPlateFormat(cand) || isStandardPlateFormat(cand))) {
      bestScore = candScore;
      bestCandidate = cand;
    }
  }

  return bestCandidate;
}

function repairIndianPlate(candidate) {
  const stateIndex = [...INDIAN_STATE_CODES]
    .map(code => ({ code, index: candidate.indexOf(code) }))
    .filter(item => item.index >= 0)
    .sort((a, b) => a.index - b.index)[0];
  if (!stateIndex) return null;

  const anchored = candidate.slice(stateIndex.index);
  if (anchored.length < 7 || anchored.length > 13) return null;
  const chars = anchored.split('');
  for (let i = 2; i < 4; i += 1) {
    if (/[A-Z]/.test(chars[i]) && LETTER_TO_DIGIT[chars[i]]) chars[i] = LETTER_TO_DIGIT[chars[i]];
  }

  const variants = [];
  for (let seriesLength = 1; seriesLength <= 3; seriesLength += 1) {
    const suffixStart = 4 + seriesLength;
    if (suffixStart >= chars.length) continue;
    const series = chars.slice(4, suffixStart).join('');
    if (!/^[A-Z0-9]+$/.test(series)) continue;
    let suffix = chars.slice(suffixStart).join('');
    suffix = suffix.replace(/[A-Z]/g, letter => LETTER_TO_DIGIT[letter] || letter);
    if (!/^\d{1,4}$/.test(suffix)) continue;
    const repaired = `${stateIndex.code}${chars.slice(2, 4).join('')}${series}${suffix}`;
    if (isIndianPlateFormat(repaired)) variants.push(repaired);
  }
  return variants[0] || null;
}

function scoreStructuralFit(text) {
  if (!text || text.length < 8 || text.length > 11) return 0;
  let score = 0;
  if (/^[A-Z]{2}/.test(text)) score += 25;
  if (/^[A-Z]{2}\d{2}/.test(text)) score += 30;
  if (/^[A-Z]{2}\d{2}[A-Z]{1,3}/.test(text)) score += 25;
  if (/\d{1,4}$/.test(text)) score += 20;
  return score;
}

/**
 * Score a candidate plate string.
 * Higher score = more likely to be a real plate.
 */
function scorePlateCandidate(text) {
  if (!text) return 0;

  let score = 0;

  // Length between 6-10 is typical for Indian plates
  if (text.length === 10) score += 25;
  else if (text.length === 9) score += 23;
  else if (text.length >= 6 && text.length <= 10) score += 20;
  else if (text.length >= 4) score += 5;

  // Check state code for 2-letter prefix
  if (/^[A-Z]{2}/.test(text)) {
    const prefix = text.slice(0, 2);
    if (INDIAN_STATE_CODES.has(prefix)) {
      score += 25;
      if (/^[A-Z]{2}\d{2}/.test(text)) score += 25;
      if (/^[A-Z]{2}\d{2}[A-Z]{1,3}\d+$/.test(text)) score += 30;
    } else {
      score -= 50; // Heavy penalty for invalid state code (e.g. AM)
    }
  }

  // Indian RTO district '00' is invalid (districts start from 01)
  if (/^[A-Z]{2}00/.test(text)) {
    score -= 60;
  }

  // MoRTH Rule: Letters 'O' and 'I' are strictly excluded from series to prevent confusion with 0/1
  if (/^[A-Z]{2}\d{2}[A-Z]{1,3}\d+$/.test(text)) {
    const seriesPart = text.slice(4).replace(/\d+$/, '');
    if (/[IO]/.test(seriesPart)) {
      score -= 40;
    }
  }

  // Matches a known Indian or general pattern
  if (isIndianPlateFormat(text)) score += 50;
  else if (isStandardPlateFormat(text)) score += 25;

  // Penalize very short or very long
  if (text.length < 4) score -= 50;
  if (text.length > 12) score -= 20;

  return score;
}

/**
 * Normalize a raw OCR text string into a clean plate number.
 *
 * @param {string} rawText - Raw OCR output
 * @returns {{ plate: string|null, normalized: boolean, corrections: string[] }}
 */
function normalizePlateText(rawText) {
  if (!rawText || typeof rawText !== 'string') {
    return { plate: null, normalized: false, corrections: [] };
  }

  const candidates = extractPlateCandidates(rawText);
  if (candidates.length === 0) {
    return { plate: null, normalized: false, corrections: [] };
  }

  const corrections = [];
  let bestPlate = null;
  let bestScore = -1;

  for (const candidate of candidates) {
    // Try with positional correction, but only in positions with a known
    // plate role. No characters are added or removed here.
    const corrected = correctIndianPlate(candidate);
    const repaired = repairIndianPlate(candidate);
    const candidatesToScore = [corrected, repaired].filter(Boolean);
    for (const repairedCandidate of candidatesToScore) {
      const repairedScore = scorePlateCandidate(repairedCandidate) + scoreStructuralFit(repairedCandidate);
      if (repairedScore > bestScore) {
        bestScore = repairedScore;
        bestPlate = repairedCandidate;
        corrections.length = 0;
        if (repairedCandidate !== candidate) {
          corrections.push(`positional_correction: ${candidate} → ${repairedCandidate}`);
        }
      }
    }
    const score = scorePlateCandidate(corrected) + scoreStructuralFit(corrected);

    if (score > bestScore) {
      bestScore = score;
      bestPlate = corrected;
      if (corrected !== candidate) {
        corrections.length = 0;
        corrections.push(`positional_correction: ${candidate} → ${corrected}`);
      }
    }

    // Also try the uncorrected version
    const rawScore = scorePlateCandidate(candidate) + scoreStructuralFit(candidate);
    if (rawScore > bestScore) {
      bestScore = rawScore;
      bestPlate = candidate;
      corrections.length = 0;
    }
  }

  // A valid result must match an Indian registration format or standard alphanumeric plate.
  if (bestPlate && bestScore >= 50 && (isIndianPlateFormat(bestPlate) || isStandardPlateFormat(bestPlate))) {
    return {
      plate: bestPlate,
      normalized: corrections.length > 0,
      corrections,
    };
  }

  return { plate: null, normalized: false, corrections: [] };
}

/**
 * Check if a plate string matches a known Indian plate format.
 */
function isIndianPlateFormat(plate) {
  if (!plate) return false;
  if (/^[A-Z]{2}00/.test(plate)) return false; // In India, RTO codes start from 01; 00 is invalid
  return INDIAN_PLATE_PATTERNS.some(p => p.test(plate))
    && (plate.includes('BH') || INDIAN_STATE_CODES.has(plate.slice(0, 2)));
}

module.exports = {
  normalizePlateText,
  cleanOcrText,
  extractPlateCandidates,
  scorePlateCandidate,
  correctIndianPlate,
  repairIndianPlate,
  isIndianPlateFormat,
  isStandardPlateFormat,
  INDIAN_PLATE_PATTERNS,
  GENERAL_PLATE_PATTERNS,
};
