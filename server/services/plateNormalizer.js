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
 *   DL6CM6683    (Delhi 1-digit RTO)
 *   GJ01AA1234
 *   MP09A1234    (older format with single letter series)
 *   HP896786     (series-less format: 2 letters, 6 digits)
 *   TN23L4547
 */
const INDIAN_PLATE_PATTERNS = [
  // Standard: XX00XX0000 (2 letters, 2 digits, 1-3 letters, 1-4 digits)
  /^[A-Z]{2}\d{2}[A-Z]{1,3}\d{1,4}$/,
  // Delhi single-digit RTO: DL0XX0000
  /^DL\d[A-Z]{1,3}\d{1,4}$/,
  // Series-less standard format: XX000000
  /^[A-Z]{2}\d{4,6}$/,
  // BH-series (Bharat series): 00BH0000XX
  /^\d{2}BH\d{4}[A-Z]{2}$/,
];

const INDIAN_STATE_CODES = new Set([
  'AN', 'AP', 'AR', 'AS', 'BR', 'CH', 'CG', 'DD', 'DL', 'DN', 'GA', 'GJ',
  'HP', 'HR', 'JH', 'JK', 'KA', 'KL', 'LA', 'LD', 'MH', 'ML', 'MN', 'MP',
  'MZ', 'NL', 'OD', 'OR', 'PB', 'PY', 'RJ', 'SK', 'TN', 'TR', 'TS', 'UA',
  'UK', 'UP', 'WB',
]);

/**
 * Maximum official RTO district number per Indian State / UT.
 * Used for boundary validation of RTO districts.
 */
const STATE_MAX_RTO = {
  'MH': 55, 'DL': 99, 'KA': 71, 'TN': 99, 'HR': 99, 'UP': 99,
  'GJ': 38, 'KL': 86, 'RJ': 58, 'WB': 99, 'MP': 70, 'AP': 39,
  'TS': 36, 'PB': 91, 'CG': 30, 'HP': 99, 'JH': 24, 'OD': 35,
  'AS': 34, 'BR': 57, 'UK': 20, 'GA': 12, 'SK': 8,  'CH': 4,
  'AN': 2,  'DN': 15, 'DD': 15, 'PY': 5,  'TR': 8,  'ML': 14,
  'NL': 8,  'MN': 7,  'MZ': 9,  'AR': 20, 'JK': 22, 'LA': 2
};

const GENERAL_PLATE_PATTERNS = [
  /^[A-Z]{1,3}\d{1,4}[A-Z]{0,3}$/,
  /^[A-Z]{1,3}\d{1,4}$/,
  /^[A-Z]{2}\d{1,2}[A-Z]{1,3}\d{1,4}$/,
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
 * Covers empirical ANPR confusion pairs derived from benchmark:
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
  'U': ['0', '3'],
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
  '6': ['G', 'C'],
  '7': ['T', 'I', 'L'],
  '8': ['B'],
};

/**
 * Nearest-neighbor correction map for OCR-confused Indian state codes.
 * Keys are observed (wrong) codes; values are the most likely correct Indian state code.
 */
const STATE_CODE_CONFUSION_MAP = {
  // MH confusions
  'HH': 'MH', 'MI': 'MH', 'MR': 'MH', 'MA': 'MH', 'MM': 'MH',
  'MU': 'MH', 'UH': 'MH', 'TH': 'MH', 'MK': 'MH', 'VH': 'MH',
  'MN': 'MH', 'UD': 'MH', 'WI': 'MH', 'LH': 'MH', 'PM': 'MH',
  'UW': 'MH', 'KH': 'MH', 'MF': 'MH',
  // RJ confusions
  'RD': 'RJ', 'RU': 'RJ', 'RL': 'RJ', 'RA': 'RJ', 'WJ': 'RJ',
  // HR confusions
  'UR': 'HR', 'HP': 'HR', 'IM': 'HR',
  // AP confusions
  'AR': 'AP',
  // BR confusions
  'PR': 'BR',
  // DL confusions
  'FD': 'DL', 'LD': 'DL', 'LJ': 'DL',
  // GJ confusions
  'EJ': 'GJ', 'G7': 'GJ',
  // TN confusions
  'M9': 'TN', 'ZN': 'TN',
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
    .replace(/[^A-Z0-9\s-]/g, '')
    .trim();
}

/**
 * Extract candidate plate substrings from raw OCR text.
 */
function extractPlateCandidates(rawText) {
  if (!rawText) return [];

  const cleaned = cleanOcrText(rawText);
  if (!cleaned) return [];

  const candidates = [];

  // 1. Direct stripped string (no spaces, no hyphens)
  const stripped = cleaned.replace(/[\s-]/g, '');
  if (stripped.length >= 6 && stripped.length <= 15) {
    candidates.push(stripped);
  }

  // 2. Lines from multi-line OCR
  const lines = rawText
    .split(/\r?\n/)
    .map(line => line.toUpperCase().replace(/[^A-Z0-9]/g, ''))
    .filter(line => line.length >= 6 && line.length <= 12);
  candidates.push(...lines);

  // 3. Space-separated or hyphen-separated parts
  const parts = cleaned.split(/[\s-]+/).filter(Boolean);
  for (const part of parts) {
    const cleanedPart = part.replace(/[^A-Z0-9]/g, '');
    if (cleanedPart.length >= 6 && cleanedPart.length <= 12) {
      candidates.push(cleanedPart);
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

  // Trailing duplicate digit or extra 5th digit on 9-char plate
  for (const candidate of cleanedCandidates) {
    if (candidate.length === 10 && (/^[A-Z]{2}\d{2}[A-Z]\d{5}$/.test(candidate) || (candidate[8] === candidate[9] && /\d{4}$/.test(candidate.slice(0, 9))))) {
      windowCandidates.push(candidate.slice(0, 9));
    }
    // Trailing duplicate reduction for 8-10 char plates (e.g. KL01AU5855 -> KL01AU585, KL01CC500 -> KL01CC50)
    if (candidate.length >= 8 && candidate[candidate.length - 1] === candidate[candidate.length - 2] && /\d{2}$/.test(candidate)) {
      windowCandidates.push(candidate.slice(0, -1));
    }
  }

  for (const candidate of cleanedCandidates) {
    for (let length = 8; length <= 12; length += 1) {
      if (candidate.length <= length) continue;
      for (let start = 0; start <= candidate.length - length; start += 1) {
        windowCandidates.push(candidate.slice(start, start + length));
      }
    }
  }

  // OCR often adds a leading/trailing character around an otherwise readable plate.
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
 */
function correctIndianPlate(stripped) {
  if (!stripped || typeof stripped !== 'string') return stripped;
  const clean = stripped.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (clean.length < 6 || clean.length > 12) return clean;

  // RULE 1: If clean is ALREADY a valid Indian plate format with valid state, no forbidden series chars:
  if (isIndianPlateFormat(clean)) {
    const prefix = clean.slice(0, 2);
    const hasRto00 = /^[A-Z]{2}00/.test(clean);
    const rtoMatch = clean.slice(2).match(/^(\d{1,2})/);
    const rtoNum = rtoMatch ? parseInt(rtoMatch[1], 10) : 0;
    const maxRto = STATE_MAX_RTO[prefix];
    const invalidRtoRange = maxRto && (rtoNum > maxRto || rtoNum === 0);
    const seriesPart = clean.slice(2 + (rtoMatch ? rtoMatch[1].length : 0)).replace(/\d+$/, '');
    const hasForbiddenSeries = /[OI]/.test(seriesPart);

    if (!hasRto00 && !invalidRtoRange && !hasForbiddenSeries) {
      // 100% syntactically valid already! Preserve exact natural reading without mutating!
      return clean;
    }
  }

  const chars = clean.split('');
  const N = chars.length;

  const templates = [];
  if (N === 10) {
    // 10A: Standard (MH12DE1433)
    templates.push(['LETTER', 'LETTER', 'DIGIT', 'DIGIT', 'LETTER', 'LETTER', 'DIGIT', 'DIGIT', 'DIGIT', 'DIGIT']);
    // 10B: 3-letter series / Trade Certificate (MH14TCF459)
    templates.push(['LETTER', 'LETTER', 'DIGIT', 'DIGIT', 'LETTER', 'LETTER', 'LETTER', 'DIGIT', 'DIGIT', 'DIGIT']);
    if (clean.startsWith('DL')) {
      templates.push(['LETTER', 'LETTER', 'DIGIT', 'LETTER', 'LETTER', 'LETTER', 'DIGIT', 'DIGIT', 'DIGIT', 'DIGIT']);
    }
  } else if (N === 9) {
    // 9A: 1 series letter, 4 digits (MP09A1234)
    templates.push(['LETTER', 'LETTER', 'DIGIT', 'DIGIT', 'LETTER', 'DIGIT', 'DIGIT', 'DIGIT', 'DIGIT']);
    // 9B: 2 series letters, 3 digits (MH02AJ344)
    templates.push(['LETTER', 'LETTER', 'DIGIT', 'DIGIT', 'LETTER', 'LETTER', 'DIGIT', 'DIGIT', 'DIGIT']);
    if (clean.startsWith('DL')) {
      templates.push(['LETTER', 'LETTER', 'DIGIT', 'LETTER', 'LETTER', 'DIGIT', 'DIGIT', 'DIGIT', 'DIGIT']);
    }
  } else if (N === 8) {
    templates.push(['LETTER', 'LETTER', 'DIGIT', 'DIGIT', 'DIGIT', 'DIGIT', 'DIGIT', 'DIGIT']);
    templates.push(['LETTER', 'LETTER', 'DIGIT', 'DIGIT', 'LETTER', 'DIGIT', 'DIGIT', 'DIGIT']);
  } else {
    const roles = new Array(N).fill('LETTER');
    roles[0] = 'LETTER'; roles[1] = 'LETTER';
    if (N > 2) roles[2] = 'DIGIT';
    if (N > 3) roles[3] = 'DIGIT';
    for (let i = Math.max(4, N - 4); i < N; i++) roles[i] = 'DIGIT';
    templates.push(roles);
  }

  let bestCandidate = clean;
  let bestScore = scorePlateCandidate(clean) + scoreStructuralFit(clean);

  for (const expectedTypes of templates) {
    const positionOptions = [];
    let hasMismatch = false;

    // Indian RTO check: No Indian state has RTO code '00'
    const hasInvalidRto00 = N >= 4 && chars[2] === '0' && chars[3] === '0';

    for (let i = 0; i < N; i++) {
      const currentChar = chars[i];
      const expected = expectedTypes[i];
      const isCharDigit = /\d/.test(currentChar);
      const isCharLetter = /[A-Z]/.test(currentChar);

      // Handle invalid RTO code '00'
      if (hasInvalidRto00 && (i === 2 || i === 3)) {
        hasMismatch = true;
        if (i === 3) {
          positionOptions.push(['9', '1', '8', '0']);
        } else {
          positionOptions.push(['0', '1']);
        }
        continue;
      }

      // Handle MoRTH Rule: Letters 'O' and 'I' are officially omitted from Indian registration series
      if (expected === 'LETTER' && isCharLetter && (i === 4 || i === 5 || i === 6)) {
        if (currentChar === 'I') {
          positionOptions.push(['A', 'T', 'J']);
          hasMismatch = true;
          continue;
        } else if (currentChar === 'O') {
          positionOptions.push(['D', 'C', 'Q']);
          hasMismatch = true;
          continue;
        } else if (currentChar === 'G' && (i === 4 || i === 5)) {
          positionOptions.push(['G', 'C']);
          hasMismatch = true;
          continue;
        } else if (currentChar === 'Y' && (i === 4 || i === 5)) {
          positionOptions.push(['Y', 'V']);
          hasMismatch = true;
          continue;
        } else if (currentChar === 'D' && (i === 4 || i === 5)) {
          positionOptions.push(['D', 'C']);
          hasMismatch = true;
          continue;
        } else if (currentChar === 'W' && (i === 4 || i === 5)) {
          positionOptions.push(['W', 'M', 'H', 'N']);
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

    if (!hasMismatch) continue;

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

    for (const cand of candidateStrings) {
      if (cand === clean) continue;
      // Positional correction should fix at most 2 OCR misread characters
      let mutationCount = 0;
      for (let i = 0; i < N; i++) {
        if (cand[i] !== clean[i]) mutationCount++;
      }
      if (mutationCount > 2) continue;

      const prefix = cand.slice(0, 2);
      if (!INDIAN_STATE_CODES.has(prefix) && !cand.includes('BH')) continue;

      const candScore = scorePlateCandidate(cand) + scoreStructuralFit(cand);
      if (candScore > bestScore && (isIndianPlateFormat(cand) || isStandardPlateFormat(cand))) {
        bestScore = candScore;
        bestCandidate = cand;
      }
    }
  }

  return bestCandidate;
}

/**
 * Attempt nearest-neighbor state code correction.
 */
function repairStateCode(candidate) {
  if (!candidate || candidate.length < 8) return [];
  const prefix = candidate.slice(0, 2);
  if (INDIAN_STATE_CODES.has(prefix)) return [];
  const correctedState = STATE_CODE_CONFUSION_MAP[prefix];
  if (!correctedState) return [];
  const repaired = correctedState + candidate.slice(2);
  if (isIndianPlateFormat(repaired) || isStandardPlateFormat(repaired)) {
    return [repaired];
  }
  return [];
}

/**
 * Trim one trailing hallucinated character if the shortened result is a valid plate.
 */
function trimTrailingHallucinatedChar(candidate) {
  if (!candidate || candidate.length < 8) return null;
  if (isIndianPlateFormat(candidate)) return null;
  const trimmed = candidate.slice(0, -1);
  if (trimmed.length >= 7 && (isIndianPlateFormat(trimmed) || isStandardPlateFormat(trimmed))) {
    return trimmed;
  }
  const trimmedFront = candidate.slice(1);
  if (trimmedFront.length >= 7 && (isIndianPlateFormat(trimmedFront) || isStandardPlateFormat(trimmedFront))) {
    return trimmedFront;
  }
  return null;
}

/**
 * Fix doubled series letter hallucination: if pos 4 and pos 5 are the same letter.
 */
function deduplicateSeriesLetter(candidate) {
  if (!candidate || candidate.length < 9) return null;
  const c4 = candidate[4];
  const c5 = candidate[5];
  if (c4 && c5 && c4 === c5 && /[A-Z]/.test(c4)) {
    // Preserve legitimate high-frequency doubled series
    if (['E', 'C', 'A', 'J'].includes(c4)) return null;
    const dedup = candidate.slice(0, 5) + candidate.slice(6);
    if (dedup.length >= 7 && (isIndianPlateFormat(dedup) || isStandardPlateFormat(dedup))) {
      return dedup;
    }
  }
  return null;
}

function repairIndianPlate(candidate) {
  const stateIndex = [...INDIAN_STATE_CODES]
    .map(code => ({ code, index: candidate.indexOf(code) }))
    .filter(item => item.index >= 0)
    .sort((a, b) => a.index - b.index)[0];

  if (!stateIndex) return null;

  const anchored = candidate.slice(stateIndex.index);
  if (anchored.length < 8 || anchored.length > 11) return null;

  const chars = anchored.split('');
  const correctedChars = [...chars];

  if (chars.length >= 4) {
    if (/[A-Z]/.test(chars[2])) correctedChars[2] = LETTER_TO_DIGIT[chars[2]] || chars[2];
    if (/[A-Z]/.test(chars[3])) correctedChars[3] = LETTER_TO_DIGIT[chars[3]] || chars[3];
  }

  const last4Start = chars.length - 4;
  for (let i = last4Start; i < chars.length; i++) {
    if (/[A-Z]/.test(chars[i])) {
      correctedChars[i] = LETTER_TO_DIGIT[chars[i]] || chars[i];
    }
  }

  const repaired = correctedChars.join('');
  return (isIndianPlateFormat(repaired) || isStandardPlateFormat(repaired)) ? repaired : null;
}

/**
 * Score structural fit for Indian vehicle registration formats.
 */
function scoreStructuralFit(text) {
  if (!text || text.length < 7 || text.length > 11) return 0;
  let score = 0;
  if (/^[A-Z]{2}/.test(text)) score += 25;
  if (/^[A-Z]{2}\d{1,2}/.test(text)) score += 30;
  if (/^[A-Z]{2}\d{1,2}[A-Z]{1,3}/.test(text)) score += 25;
  if (/\d{4}$/.test(text)) score += 25;
  else if (/\d{1,3}$/.test(text)) score += 15;
  return score;
}

/**
 * Score a candidate plate string.
 * Higher score = more likely to be a real plate.
 */
function scorePlateCandidate(text) {
  if (!text) return 0;

  let score = 0;

  // Length between 6-10 is typical for Indian plates (both 9 and 10 are standard formats)
  if (text.length === 10 || text.length === 9) score += 25;
  else if (text.length >= 6 && text.length <= 10) score += 20;
  else if (text.length >= 4) score += 5;

  // Check state code for 2-letter prefix
  if (/^[A-Z]{2}/.test(text)) {
    const prefix = text.slice(0, 2);
    if (INDIAN_STATE_CODES.has(prefix)) {
      score += 25;
      if (/^[A-Z]{2}\d{1,2}/.test(text)) score += 25;
      if (/^[A-Z]{2}\d{1,2}[A-Z]{1,3}\d+$/.test(text)) score += 30;

      // Validate RTO district range
      const rtoMatch = text.slice(2).match(/^(\d{1,2})/);
      if (rtoMatch) {
        const rtoNum = parseInt(rtoMatch[1], 10);
        const maxRto = STATE_MAX_RTO[prefix];
        if (maxRto && (rtoNum > maxRto || rtoNum === 0)) {
          score -= 40; // Penalize impossible RTO district for that state
        }
      }
    } else {
      score -= 50; // Heavy penalty for invalid state code (e.g. AM)
    }
  }

  // Indian RTO district '00' is invalid (districts start from 01)
  if (/^[A-Z]{2}00/.test(text)) {
    score -= 60;
  }

  // MoRTH Rule: Letters 'O' and 'I' are strictly excluded from series to prevent confusion with 0/1
  if (/^[A-Z]{2}\d{1,2}[A-Z]{1,3}\d+$/.test(text)) {
    const seriesPart = text.slice(text[3] >= '0' && text[3] <= '9' ? 4 : 3).replace(/\d+$/, '');
    if (/[IO]/.test(seriesPart)) {
      score -= 40;
    }
  }

  // Matches a known Indian or general pattern
  if (isIndianPlateFormat(text)) score += 50;
  else if (isStandardPlateFormat(text)) score += 25;

  // Prefer complete standard 4-digit number
  if (/\d{4}$/.test(text)) score += 5;

  // Penalize very short or very long
  if (text.length < 4) score -= 50;
  if (text.length > 12) score -= 30;

  return score;
}

/**
 * Normalize and correct plate text from raw OCR output.
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
    const corrected = correctIndianPlate(candidate);
    const repaired = repairIndianPlate(candidate);
    const candidatesToScore = [repaired, corrected].filter(Boolean);
    for (const scoredCand of candidatesToScore) {
      // Tie-break penalty: unmutated exact natural reading beats mutated candidate on ties
      const penalty = (scoredCand !== candidate) ? 2 : 0;
      const score = scorePlateCandidate(scoredCand) + scoreStructuralFit(scoredCand) - penalty;
      if (score > bestScore) {
        bestScore = score;
        bestPlate = scoredCand;
        corrections.length = 0;
        if (scoredCand !== candidate) {
          corrections.push(`positional_correction: ${candidate} → ${scoredCand}`);
        }
      }
    }

    // Also try the uncorrected version
    const rawScore = scorePlateCandidate(candidate) + scoreStructuralFit(candidate);
    if (rawScore > bestScore) {
      bestScore = rawScore;
      bestPlate = candidate;
      corrections.length = 0;
    }

    // Try state code nearest-neighbor repair
    for (const stateRepaired of repairStateCode(corrected || candidate)) {
      const stateScore = scorePlateCandidate(stateRepaired) + scoreStructuralFit(stateRepaired) - 1;
      if (stateScore > bestScore) {
        bestScore = stateScore;
        bestPlate = stateRepaired;
        corrections.length = 0;
        corrections.push(`state_code_repair: ${corrected || candidate} → ${stateRepaired}`);
      }
    }

    // Try trimming trailing hallucinated char
    const trimTarget = corrected || candidate;
    const trimmedResult = trimTrailingHallucinatedChar(trimTarget);
    if (trimmedResult) {
      const trimScore = scorePlateCandidate(trimmedResult) + scoreStructuralFit(trimmedResult);
      if (trimScore > bestScore) {
        bestScore = trimScore;
        bestPlate = trimmedResult;
        corrections.length = 0;
        corrections.push(`trim_hallucination: ${trimTarget} → ${trimmedResult}`);
      }
    }

    // Deduplicate doubled series letter safely
    const dedupResult = deduplicateSeriesLetter(corrected || candidate);
    if (dedupResult) {
      const dedupScore = scorePlateCandidate(dedupResult) + scoreStructuralFit(dedupResult);
      if (dedupScore >= bestScore) {
        bestScore = dedupScore;
        bestPlate = dedupResult;
        corrections.length = 0;
        corrections.push(`dedup_series: ${corrected || candidate} → ${dedupResult}`);
      }
    }
  }

  // Standard Indian registration numbers overwhelmingly end in 4 digits.
  // If a 9-char candidate ended with 3 digits because a digit was read as a letter (e.g. KL63CB800 -> KL63C8800),
  // prefer the standard 4-digit form.
  if (bestPlate && bestPlate.length === 9 && /^[A-Z]{2}\d{2}[A-Z]{2}\d{3}$/.test(bestPlate)) {
    const char5 = bestPlate[5];
    const digitMap = { 'B': '8', 'Z': '2', 'G': '6', 'S': '5', 'D': '0', 'O': '0', 'L': '1', 'I': '1', 'A': '4' };
    if (digitMap[char5]) {
      const candidate4D = bestPlate.slice(0, 5) + digitMap[char5] + bestPlate.slice(6);
      if (isIndianPlateFormat(candidate4D)) {
        bestPlate = candidate4D;
        corrections.push(`4digit_preference: ${char5} → ${digitMap[char5]}`);
      }
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
  if (!plate || typeof plate !== 'string') return false;
  const clean = plate.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (/^[A-Z]{2}\d/.test(clean)) {
    if (!INDIAN_STATE_CODES.has(clean.slice(0, 2))) return false;
  }
  return INDIAN_PLATE_PATTERNS.some(pattern => pattern.test(clean));
}

module.exports = {
  normalizePlateText,
  cleanOcrText,
  extractPlateCandidates,
  scorePlateCandidate,
  correctIndianPlate,
  repairIndianPlate,
  repairStateCode,
  trimTrailingHallucinatedChar,
  deduplicateSeriesLetter,
  isIndianPlateFormat,
  isStandardPlateFormat,
  INDIAN_PLATE_PATTERNS,
  GENERAL_PLATE_PATTERNS,
  STATE_CODE_CONFUSION_MAP,
  STATE_MAX_RTO,
};
