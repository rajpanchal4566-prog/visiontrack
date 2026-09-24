const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const INPUT_SIZE = 640;
const MAX_IMAGE_BYTES = Number(process.env.CAMERA_IMAGE_LIMIT_BYTES) || 50 * 1024 * 1024;
const MIN_IMAGE_DIMENSION = 32;
const DEFAULT_CONFIDENCE = 0.25;
const DEFAULT_IOU = 0.45;
const DEFAULT_MODEL_PATH = path.join(__dirname, '..', '..', 'models', 'yolov8n.onnx');

const COCO_LABELS = [
  'person', 'bicycle', 'car', 'motorcycle', 'airplane', 'bus', 'train', 'truck', 'boat',
  'traffic light', 'fire hydrant', 'stop sign', 'parking meter', 'bench', 'bird', 'cat',
  'dog', 'horse', 'sheep', 'cow', 'elephant', 'bear', 'zebra', 'giraffe', 'backpack',
  'umbrella', 'handbag', 'tie', 'suitcase', 'frisbee', 'skis', 'snowboard', 'sports ball',
  'kite', 'baseball bat', 'baseball glove', 'skateboard', 'surfboard', 'tennis racket',
  'bottle', 'wine glass', 'cup', 'fork', 'knife', 'spoon', 'bowl', 'banana', 'apple',
  'sandwich', 'orange', 'broccoli', 'carrot', 'hot dog', 'pizza', 'donut', 'cake', 'chair',
  'couch', 'potted plant', 'bed', 'dining table', 'toilet', 'tv', 'laptop', 'mouse',
  'remote', 'keyboard', 'cell phone', 'microwave', 'oven', 'toaster', 'sink', 'refrigerator',
  'book', 'clock', 'vase', 'scissors', 'teddy bear', 'hair drier', 'toothbrush',
];

const VEHICLE_LABELS = new Set(['bicycle', 'car', 'motorcycle', 'bus', 'truck']);
const EXTENDED_LABELS = new Set(['person', 'bicycle', 'car', 'motorcycle', 'bus', 'truck']);
const vehicleSessionCache = new Map();
let ortModule = null;

function getOrt() {
  if (!ortModule) ortModule = require('onnxruntime-node');
  return ortModule;
}

function getModelPath() {
  return process.env.VEHICLE_MODEL_PATH
    ? path.resolve(process.env.VEHICLE_MODEL_PATH)
    : DEFAULT_MODEL_PATH;
}

async function getSession() {
  const modelPath = getModelPath();
  if (!fs.existsSync(modelPath)) {
    const error = new Error(`Vehicle detector model not found at ${modelPath}`);
    error.code = 'VEHICLE_MODEL_NOT_AVAILABLE';
    throw error;
  }
  if (!vehicleSessionCache.has(modelPath)) {
    const sessionOptions = {
      intraOpNumThreads: Number(process.env.ONNX_NUM_THREADS) || 6,
      interOpNumThreads: 1,
      graphOptimizationLevel: 'all',
      executionMode: 'sequential',
    };
    const promise = getOrt().InferenceSession.create(modelPath, sessionOptions).catch((error) => {
      vehicleSessionCache.delete(modelPath);
      error.code = 'VEHICLE_MODEL_LOAD_FAILED';
      throw error;
    });
    vehicleSessionCache.set(modelPath, promise);
  }
  return vehicleSessionCache.get(modelPath);
}

function resolveLocalImagePath(input) {
  if (!input || typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed || /^data:image\//i.test(trimmed) || /^[a-z0-9+/\s]+=*$/i.test(trimmed)) return null;
  if (trimmed.startsWith('/uploads/') || trimmed.startsWith('uploads/')) {
    const candidates = [
      path.join(__dirname, '..', trimmed.replace(/^\//, '')),
      path.join(__dirname, '..', '..', trimmed.replace(/^\//, '')),
    ];
    return candidates.find(candidate => fs.existsSync(candidate)) || null;
  }
  return fs.existsSync(trimmed) ? trimmed : null;
}

async function resolveImageBuffer(input) {
  if (Buffer.isBuffer(input)) return input;
  if (typeof input !== 'string' || !input.trim()) return null;
  const trimmed = input.trim();
  const dataUri = trimmed.match(/^data:image\/[^;]+;base64,(.+)$/i);
  if (dataUri) return Buffer.from(dataUri[1], 'base64');
  if (/^[a-z0-9+/\s]+=*$/i.test(trimmed) && trimmed.length > 100) {
    return Buffer.from(trimmed.replace(/\s/g, ''), 'base64');
  }
  const localPath = resolveLocalImagePath(trimmed);
  if (localPath) {
    const stats = fs.statSync(localPath);
    if (stats.size > MAX_IMAGE_BYTES) {
      const error = new Error('Image exceeds the vehicle detector size limit');
      error.code = 'IMAGE_TOO_LARGE';
      throw error;
    }
    return fs.readFileSync(localPath);
  }
  if (/^https?:\/\//i.test(trimmed)) {
    const response = await fetch(trimmed);
    if (!response.ok) return null;
    const contentLength = Number(response.headers.get('content-length') || 0);
    if (contentLength > MAX_IMAGE_BYTES) {
      const error = new Error('Image exceeds the vehicle detector size limit');
      error.code = 'IMAGE_TOO_LARGE';
      throw error;
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_IMAGE_BYTES) {
      const error = new Error('Image exceeds the vehicle detector size limit');
      error.code = 'IMAGE_TOO_LARGE';
      throw error;
    }
    return buffer;
  }
  return null;
}

async function prepareInput(imageBuffer) {
  const image = sharp(imageBuffer).rotate();
  const metadata = await image.metadata();
  if (!metadata.width || !metadata.height) throw new Error('Image could not be decoded');
  if (metadata.width < MIN_IMAGE_DIMENSION || metadata.height < MIN_IMAGE_DIMENSION) {
    const error = new Error('Image is too small for vehicle detection');
    error.code = 'IMAGE_TOO_SMALL';
    throw error;
  }
  let width = metadata.width;
  let height = metadata.height;
  if (metadata.orientation && metadata.orientation >= 5 && metadata.orientation <= 8) {
    width = metadata.height;
    height = metadata.width;
  }
  const scale = Math.min(INPUT_SIZE / width, INPUT_SIZE / height);
  const resizedWidth = Math.max(1, Math.round(width * scale));
  const resizedHeight = Math.max(1, Math.round(height * scale));
  const padX = Math.floor((INPUT_SIZE - resizedWidth) / 2);
  const padY = Math.floor((INPUT_SIZE - resizedHeight) / 2);
  const { data } = await image
    .resize({ width: resizedWidth, height: resizedHeight, fit: 'fill' })
    .flatten({ background: { r: 114, g: 114, b: 114 } })
    .extend({ top: padY, bottom: INPUT_SIZE - resizedHeight - padY, left: padX, right: INPUT_SIZE - resizedWidth - padX, background: { r: 114, g: 114, b: 114 } })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const planeSize = INPUT_SIZE * INPUT_SIZE;
  const tensorData = new Float32Array(planeSize * 3);
  for (let index = 0; index < planeSize; index += 1) {
    tensorData[index] = data[index * 3] / 255;
    tensorData[planeSize + index] = data[index * 3 + 1] / 255;
    tensorData[planeSize * 2 + index] = data[index * 3 + 2] / 255;
  }
  return { tensorData, metadata: { width, height }, scale, padX, padY };
}

function intersectionOverUnion(first, second) {
  const left = Math.max(first.x, second.x);
  const top = Math.max(first.y, second.y);
  const right = Math.min(first.x + first.width, second.x + second.width);
  const bottom = Math.min(first.y + first.height, second.y + second.height);
  const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
  const union = first.width * first.height + second.width * second.height - intersection;
  return union > 0 ? intersection / union : 0;
}

function nonMaximumSuppression(detections, iouThreshold) {
  const kept = [];
  for (const detection of detections.sort((a, b) => b.confidence - a.confidence)) {
    if (!kept.some(selected => selected.vehicle_type === detection.vehicle_type && intersectionOverUnion(selected.vehicle_bbox, detection.vehicle_bbox) > iouThreshold)) {
      kept.push(detection);
    }
  }
  return kept;
}

function decodeOutput(output, preparation, confidenceThreshold = DEFAULT_CONFIDENCE, iouThreshold = DEFAULT_IOU, options = {}) {
  const dims = output.dims || [];
  const values = output.data;
  if (dims.length !== 3 || dims[0] !== 1) return [];
  const channelFirst = dims[1] > 4 && dims[1] <= 256 && (dims[2] > dims[1] || dims[2] <= 4);
  const attributes = channelFirst ? dims[1] : dims[2];
  const count = channelFirst ? dims[2] : dims[1];
  const getValue = (row, column) => channelFirst ? values[row * count + column] : values[column * attributes + row];
  const detections = [];
  const allowedLabels = options.includeOccupants ? EXTENDED_LABELS : VEHICLE_LABELS;

  for (let index = 0; index < count; index += 1) {
    const centerX = getValue(0, index);
    const centerY = getValue(1, index);
    const width = getValue(2, index);
    const height = getValue(3, index);
    if (![centerX, centerY, width, height].every(Number.isFinite)) continue;
    let bestClass = -1;
    let bestConfidence = 0;
    for (let classIndex = 4; classIndex < attributes; classIndex += 1) {
      const label = COCO_LABELS[classIndex - 4];
      if (!allowedLabels.has(label)) continue;
      const confidence = getValue(classIndex, index);
      if (confidence > bestConfidence) {
        bestConfidence = confidence;
        bestClass = classIndex - 4;
      }
    }
    if (bestClass < 0 || bestConfidence < confidenceThreshold) continue;
    const label = COCO_LABELS[bestClass];
    const left = Math.max(0, Math.min(preparation.metadata.width, (centerX - width / 2 - preparation.padX) / preparation.scale));
    const top = Math.max(0, Math.min(preparation.metadata.height, (centerY - height / 2 - preparation.padY) / preparation.scale));
    const right = Math.max(left, Math.min(preparation.metadata.width, (centerX + width / 2 - preparation.padX) / preparation.scale));
    const bottom = Math.max(top, Math.min(preparation.metadata.height, (centerY + height / 2 - preparation.padY) / preparation.scale));
    const bbox = { x: Math.round(left), y: Math.round(top), width: Math.round(right - left), height: Math.round(bottom - top) };
    if (bbox.width >= 8 && bbox.height >= 8) {
      detections.push({ vehicle_type: label, vehicle_confidence: Math.round(bestConfidence * 10000) / 10000, vehicle_bbox: bbox });
    }
  }
  return nonMaximumSuppression(detections, iouThreshold);
}

function normalizeVendorVehicleType(value) {
  if (!value) return null;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'bike' || normalized === 'motorbike') return 'motorcycle';
  if (normalized === 'sedan' || normalized === 'suv' || normalized === 'auto') return 'car';
  return normalized;
}

function compareVendorType(vendorType, detectedType) {
  if (!vendorType || !detectedType) return null;
  return normalizeVendorVehicleType(vendorType) === normalizeVendorVehicleType(detectedType);
}

function failureResult(status, error = null) {
  return {
    vehicle_detected: false,
    detected_vehicle_type: null,
    vehicle_confidence: 0,
    vehicle_bbox: null,
    vehicle_detection_status: status,
    vehicle_detection_error: error,
  };
}

async function detectVehicles(image, options = {}) {
  const startedAt = Date.now();
  if (!image) return { ...failureResult('missing_image'), processing_time_ms: 0 };
  try {
    const imageBuffer = await resolveImageBuffer(image);
    if (!imageBuffer) return { ...failureResult('unreadable_image'), processing_time_ms: Date.now() - startedAt };
    const preparation = await prepareInput(imageBuffer);
    const session = await getSession();
    const ort = getOrt();
    const tensor = new ort.Tensor('float32', preparation.tensorData, [1, 3, INPUT_SIZE, INPUT_SIZE]);
    const outputs = await session.run({ [session.inputNames[0]]: tensor });
    const allDetections = decodeOutput(outputs[session.outputNames[0]], preparation, options.confidenceThreshold, options.iouThreshold, options);
    const vehicleOnlyDetections = allDetections.filter(d => VEHICLE_LABELS.has(d.vehicle_type));
    const best = vehicleOnlyDetections[0] || null;
    const occupants = allDetections.filter(d => d.vehicle_type === 'person');
    const result = best
      ? { vehicle_detected: true, detected_vehicle_type: best.vehicle_type, vehicle_confidence: best.vehicle_confidence, vehicle_bbox: best.vehicle_bbox, vehicle_detection_status: 'detected', vehicle_detection_error: null }
      : failureResult('no_vehicle_detected');
    const vendorType = options.vendorVehicleType || null;
    return {
      ...result,
      vendor_vehicle_type: vendorType,
      vehicle_type_match: compareVendorType(vendorType, result.detected_vehicle_type),
      processing_time_ms: Date.now() - startedAt,
      vehicle_detections: vehicleOnlyDetections,
      all_detections: allDetections,
      occupants,
      image: { width: preparation.metadata.width, height: preparation.metadata.height },
    };
  } catch (error) {
    return {
      ...failureResult(error.code || 'detection_failed', error.message),
      vendor_vehicle_type: options.vendorVehicleType || null,
      vehicle_type_match: null,
      processing_time_ms: Date.now() - startedAt,
    };
  }
}

async function shutdownVehicleDetector() {
  for (const promise of vehicleSessionCache.values()) {
    const session = await promise;
    if (session.release) await session.release();
  }
  vehicleSessionCache.clear();
}

module.exports = {
  detectVehicles,
  decodeOutput,
  normalizeVendorVehicleType,
  compareVendorType,
  getModelPath,
  shutdownVehicleDetector,
};
