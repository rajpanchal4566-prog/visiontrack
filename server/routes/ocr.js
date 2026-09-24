// ============================================
// VisionTrack — OCR Test API Route
// Development/test endpoint for OCR processing.
// Does NOT replace any production detection endpoint.
// ============================================
const express = require('express');
const multer = require('multer');
const { processPlateImage, findOcrImageSource, resolveImageForOcr } = require('../services/ocrService');
const { recognizeWithPlateRecognizer } = require('../services/ocrProviders');

const router = express.Router();
const cameraImageLimitBytes = Number(process.env.CAMERA_IMAGE_LIMIT_BYTES) || 50 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: cameraImageLimitBytes, files: 1 },
}).single('image');

/**
 * POST /api/ocr/test
 *
 * Accepts an image via:
 *   - multipart/form-data with field name "image"
 *   - JSON body with "image" (base64 or data URI) or "image_url"
 *
 * Returns OCR result without creating a detection record.
 */
router.post('/test', upload, async (req, res) => {
  try {
    let imageInput = null;

    // Priority 1: multipart file upload
    if (req.file && req.file.buffer) {
      imageInput = req.file.buffer;
      console.log(`[OCR] /api/ocr/test: Received file upload "${req.file.originalname}" (${req.file.size} bytes, ${req.file.mimetype})`);
    }

    // Priority 2: JSON body image fields
    if (!imageInput) {
      imageInput = findOcrImageSource(req.body || {});
      if (imageInput) {
        console.log(`[OCR] /api/ocr/test: Received image from JSON body (${typeof imageInput === 'string' ? imageInput.length + ' chars' : 'buffer'})`);
      }
    }

    if (!imageInput) {
      return res.status(400).json({
        success: false,
        error: 'no_image',
        errorDetail: 'No image provided. Upload an image file or send base64/URL in the request body.',
        plate: null,
        rawText: '',
        confidence: 0,
        processingTime: 0,
        ocrStatus: 'NO_IMAGE',
      });
    }

    const result = await processPlateImage(imageInput);

    return res.json({
      success: result.success,
      plate: result.plate,
      vendor_plate: result.vendor_plate || null,
      detected_plate: result.detected_plate || result.plate || null,
      plate_match: result.plate_match ?? null,
      plate_detected: result.plate_detected || false,
      plate_confidence: result.plate_confidence || 0,
      plate_bbox: result.plate_bbox || null,
      rawText: result.rawText,
      ocr_raw: result.rawText,
      confidence: result.confidence,
      detectorConfidence: result.detectorConfidence ?? null,
      ocrConfidence: result.ocrConfidence || result.confidence,
      plate_source: result.plate_source || null,
      local_ocr_plate: result.local_ocr_plate || null,
      local_ocr_confidence: result.local_ocr_confidence || 0,
      plate_recognizer_plate: result.plate_recognizer_plate || null,
      plate_recognizer_confidence: result.plate_recognizer_confidence || 0,
      plates_agree: result.plates_agree ?? null,
      fusion_decision: result.fusion_decision || null,
      candidate_plate: result.candidate_plate || null,
      local_raw_text: result.local_raw_text || null,
      provider_raw_text: result.provider_raw_text || null,
      provider_normalized_plate: result.provider_normalized_plate || null,
      fusion_similarity: result.fusion_similarity ?? 0,
      plate_recognizer_status: result.plate_recognizer_status || null,
      plate_recognizer_error: result.plate_recognizer_error || null,
      finalConfidence: result.finalConfidence || 0,
      plateVerificationStatus: result.plate_verification_status || null,
      processingTime: result.processingTimeMs,
      timings: result.timings,
      plateRegion: result.plateRegion,
      plateCrop: result.plateCrop,
      candidateCount: result.candidateCount || 0,
      candidateRegions: result.candidateRegions || [],
      candidateRegions: result.candidateRegions || [],
      corrections: result.corrections,
      variantUsed: result.variantUsed,
      psmUsed: result.psmUsed,
      allResults: result.allResults,
      candidates: result.candidates || [],
      preprocessingInfo: result.preprocessingInfo,
      error: result.error || null,
      errorDetail: result.errorDetail || null,
      ocrStatus: result.ocrStatus,
    });

  } catch (err) {
    console.error('[OCR_FAILED] /api/ocr/test error:', err.message);
    return res.status(500).json({
      success: false,
      error: 'internal_error',
      errorDetail: err.message,
      plate: null,
      rawText: '',
      confidence: 0,
      processingTime: 0,
      timings: null,
      plateRegion: null,
      plateCrop: null,
      detectorConfidence: 0,
      ocrConfidence: 0,
      finalConfidence: 0,
      candidateCount: 0,
      candidateRegions: [],
      candidates: [],
      candidateRegions: [],
      ocrStatus: 'INTERNAL_ERROR',
    });
  }
});

router.post('/plate-recognizer/test', upload, async (req, res) => {
  try {
    const imageInput = req.file?.buffer || findOcrImageSource(req.body || {});
    if (!imageInput) return res.status(400).json({ success: false, error: 'no_image' });

    const imageBuffer = Buffer.isBuffer(imageInput)
      ? imageInput
      : await resolveImageForOcr(imageInput);
    const result = await recognizeWithPlateRecognizer(imageBuffer);
    return res.json({
      success: result.success,
      configured: result.configured,
      status: result.status,
      plate: result.plate,
      confidence: result.confidence,
      error: result.error || null,
    });
  } catch (error) {
    return res.status(502).json({
      success: false,
      configured: Boolean(process.env.PLATE_RECOGNIZER_TOKEN),
      status: 'NETWORK_ERROR',
      plate: null,
      confidence: 0,
      error: error.message,
    });
  }
});

/**
 * GET /api/ocr/status
 */
router.get('/status', (req, res) => {
  res.json({
    engine: 'tesseract.js + plate-recognizer',
    plateRecognizer: process.env.PLATE_RECOGNIZER_TOKEN ? 'configured' : 'not_configured',
    version: '7.0.0',
    status: 'available',
    supportedFormats: ['jpeg', 'jpg', 'png', 'webp', 'bmp', 'gif'],
    maxFileSize: `${Math.round(cameraImageLimitBytes / 1024 / 1024)}MB`,
    preprocessingVariants: ['balanced', 'high_contrast', 'minimal', 'tight_line'],
    psmModes: ['single_line (PSM 7)'],
    maxPlateCandidates: 5,
  });
});

module.exports = router;
