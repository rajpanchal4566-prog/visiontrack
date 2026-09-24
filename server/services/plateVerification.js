const { processPlateImage } = require('./ocrService');

function comparablePlate(value) {
  if (value === undefined || value === null) return null;
  const normalized = String(value).toUpperCase().replace(/[^A-Z0-9]/g, '');
  return normalized || null;
}

async function verifyPlateImage(imageInput, options = {}) {
  const result = await processPlateImage(imageInput);
  const vendorPlate = comparablePlate(options.vendorPlate);
  const detectedPlate = comparablePlate(result.plate);

  return {
    ...result,
    vendor_plate: vendorPlate,
    detected_plate: detectedPlate,
    plate_match: vendorPlate && detectedPlate ? vendorPlate === detectedPlate : null,
    plate_verification_status: result.fusion_decision
      || (result.success ? 'verified' : (result.error || 'NO_VALID_PLATE')),
  };
}

module.exports = {
  verifyPlateImage,
  comparablePlate,
};
