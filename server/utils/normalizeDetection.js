const {
  normalizeDetection,
  normalizeImage,
  normalizeVehicleType,
  normalizePlate,
  normalizeConfidence,
  expandPayloads,
  detectVendor,
  resolveField,
  VENDOR_PROFILES,
  FIELD_ALIASES,
} = require('../services/vendorAdapter');

function normalizeIncomingDetection(body, uploadedFile = null) {
  const { detection } = normalizeDetection(body, { uploadedFile, saveImages: true });
  return detection;
}

module.exports = {
  normalizeIncomingDetection,
  normalizeDetection,
  normalizeImage,
  normalizeVehicleType,
  normalizePlate,
  normalizeConfidence,
  expandPayloads,
  detectVendor,
  resolveField,
  VENDOR_PROFILES,
  FIELD_ALIASES,
};
