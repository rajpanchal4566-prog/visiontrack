const { isIndianPlateFormat, isStandardPlateFormat, normalizePlateText } = require('./plateNormalizer');

const DEFAULT_PROVIDER_THRESHOLD = 0.7;

function normalized(value) {
  if (!value) return null;
  const result = normalizePlateText(String(value));
  return result.plate && (isIndianPlateFormat(result.plate) || isStandardPlateFormat(result.plate)) ? result.plate : null;
}

function similarity(first, second) {
  if (!first || !second || first.length !== second.length) return 0;
  let matches = 0;
  for (let index = 0; index < first.length; index += 1) {
    if (first[index] === second[index]) matches += 1;
  }
  return matches / first.length;
}

function fuseOcrResults({
  localRawText,
  localNormalizedPlate = null,
  localConfidence = 0,
  providerPlate,
  providerRawText = null,
  providerConfidence = 0,
  detectorConfidence = 0,
  cropWidth = 0,
  cropHeight = 0,
  providerThreshold = Number(process.env.PLATE_RECOGNIZER_MIN_CONFIDENCE) || DEFAULT_PROVIDER_THRESHOLD,
}) {
  const localPlate = normalized(localNormalizedPlate) || normalized(localRawText);
  const providerPlateNormalized = normalized(providerPlate || providerRawText);
  const localScore = Math.max(0, Math.min(1, Number(localConfidence) > 1 ? Number(localConfidence) / 100 : Number(localConfidence)));
  const providerScore = Math.max(0, Math.min(1, Number(providerConfidence)));
  const detectorScore = Math.max(0, Math.min(1, Number(detectorConfidence)));
  const cropQuality = Math.min(1, (Number(cropWidth) / 80)) * Math.min(1, (Number(cropHeight) / 20));
  const providerEvidence = providerScore * 0.6 + detectorScore * 0.2 + cropQuality * 0.2;
  const agrees = Boolean(localPlate && providerPlateNormalized && localPlate === providerPlateNormalized);
  const plausibleDifference = Boolean(localPlate && providerPlateNormalized
    && localPlate.length === providerPlateNormalized.length
    && similarity(localPlate, providerPlateNormalized) >= 0.8);

  let decision = 'NO_VALID_PLATE';
  let plate = null;
  let confidence = 0;
  let source = null;
  if (agrees) {
    decision = 'AGREEMENT_VERIFIED';
    plate = localPlate;
    confidence = Math.min(1, (localScore + providerScore) / 2 + 0.15);
    source = 'ocr_fusion';
  } else if (localPlate && !providerPlateNormalized) {
    decision = 'LOCAL_ONLY';
    plate = localPlate;
    confidence = Math.max(localScore, detectorScore || 0.75, 0.75);
    source = 'local_ocr';
  } else if (!localPlate && providerPlateNormalized && providerScore >= providerThreshold && providerEvidence >= 0.65) {
    decision = 'PROVIDER_SUPPORTED';
    confidence = providerEvidence;
  } else if (localPlate && providerPlateNormalized) {
    decision = plausibleDifference ? 'NEEDS_CONFIRMATION' : 'REJECTED';
  } else if (providerPlateNormalized) {
    decision = 'REJECTED';
  }

  return {
    decision,
    plate,
    confidence,
    source,
    localRawText: localRawText || null,
    localConfidence: localScore,
    localNormalizedPlate: localPlate,
    providerRawText: providerRawText || providerPlate || null,
    providerConfidence: providerScore,
    providerNormalizedPlate: providerPlateNormalized,
    providerEvidence,
    similarity: localPlate && providerPlateNormalized ? similarity(localPlate, providerPlateNormalized) : 0,
    platesAgree: agrees,
    candidatePlate: providerPlateNormalized || localPlate,
  };
}

module.exports = { fuseOcrResults, similarity, DEFAULT_PROVIDER_THRESHOLD };
