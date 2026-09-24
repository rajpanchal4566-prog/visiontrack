const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const INPUT_SIZE = 640;
const DEFAULT_CONFIDENCE = 0.25;
const DEFAULT_IOU = 0.45;
const MAX_DETECTIONS = 12;
const DEFAULT_MODEL_PATH = path.join(__dirname, '..', '..', 'models', 'license-plate-yolov8.onnx');

let ortModule = null;
let sessionPromise = null;

function getOrt() {
  if (!ortModule) ortModule = require('onnxruntime-node');
  return ortModule;
}

function getModelPath() {
  return process.env.OCR_PLATE_MODEL_PATH
    ? path.resolve(process.env.OCR_PLATE_MODEL_PATH)
    : DEFAULT_MODEL_PATH;
}

async function getSession() {
  const modelPath = getModelPath();
  if (!fs.existsSync(modelPath)) {
    const error = new Error(`Plate detector model not found at ${modelPath}`);
    error.code = 'PLATE_MODEL_NOT_AVAILABLE';
    throw error;
  }

  if (!sessionPromise) {
    const sessionOptions = {
      intraOpNumThreads: Number(process.env.ONNX_NUM_THREADS) || 6,
      interOpNumThreads: 1,
      graphOptimizationLevel: 'all',
      executionMode: 'sequential',
    };
    sessionPromise = getOrt().InferenceSession.create(modelPath, sessionOptions).catch((error) => {
      sessionPromise = null;
      error.code = 'PLATE_MODEL_LOAD_FAILED';
      throw error;
    });
  }
  return sessionPromise;
}

async function prepareInput(imageBuffer) {
  const image = sharp(imageBuffer).rotate();
  const metadata = await image.metadata();
  if (!metadata.width || !metadata.height) {
    const error = new Error('Image could not be decoded');
    error.code = 'INVALID_IMAGE';
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
    .extend({
      top: padY,
      bottom: INPUT_SIZE - resizedHeight - padY,
      left: padX,
      right: INPUT_SIZE - resizedWidth - padX,
      background: { r: 114, g: 114, b: 114 },
    })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const channels = 3;
  const tensorData = new Float32Array(channels * INPUT_SIZE * INPUT_SIZE);
  const planeSize = INPUT_SIZE * INPUT_SIZE;
  for (let index = 0; index < planeSize; index += 1) {
    tensorData[index] = data[index * 3] / 255;
    tensorData[planeSize + index] = data[index * 3 + 1] / 255;
    tensorData[planeSize * 2 + index] = data[index * 3 + 2] / 255;
  }

  return {
    tensorData,
    metadata: { width, height },
    scale,
    padX,
    padY,
  };
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
    if (!kept.some((selected) => intersectionOverUnion(selected, detection) > iouThreshold)) {
      kept.push(detection);
    }
    if (kept.length >= MAX_DETECTIONS) break;
  }
  return kept;
}

function decodeDetections(output, preparation, confidenceThreshold, iouThreshold) {
  const dimensions = output.dims || [];
  const values = output.data;
  const channels = dimensions.length === 3 ? dimensions[1] : 5;
  const count = dimensions.length === 3 ? dimensions[2] : Math.floor(values.length / channels);
  const detections = [];

  for (let index = 0; index < count; index += 1) {
    const centerX = values[index];
    const centerY = values[count + index];
    const width = values[count * 2 + index];
    const height = values[count * 3 + index];
    const confidence = values[count * 4 + index];
    if (!Number.isFinite(confidence) || confidence < confidenceThreshold) continue;

    const expW = width * 0.06;
    const expH = height * 0.04;
    const left = (centerX - (width + expW) / 2 - preparation.padX) / preparation.scale;
    const top = (centerY - (height + expH) / 2 - preparation.padY) / preparation.scale;
    const right = (centerX + (width + expW) / 2 - preparation.padX) / preparation.scale;
    const bottom = (centerY + (height + expH) / 2 - preparation.padY) / preparation.scale;
    const x = Math.max(0, Math.min(preparation.metadata.width, left));
    const y = Math.max(0, Math.min(preparation.metadata.height, top));
    const clippedRight = Math.max(x, Math.min(preparation.metadata.width, right));
    const clippedBottom = Math.max(y, Math.min(preparation.metadata.height, bottom));
    const detection = {
      x: Math.round(x),
      y: Math.round(y),
      width: Math.round(clippedRight - x),
      height: Math.round(clippedBottom - y),
      confidence: Math.round(confidence * 10000) / 10000,
    };
    if (detection.width >= 8 && detection.height >= 4) detections.push(detection);
  }

  return nonMaximumSuppression(detections, iouThreshold);
}

async function detectPlate(imageBuffer, options = {}) {
  const startedAt = Date.now();
  const preparation = await prepareInput(imageBuffer);
  const session = await getSession();
  const ort = getOrt();
  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];
  const tensor = new ort.Tensor('float32', preparation.tensorData, [1, 3, INPUT_SIZE, INPUT_SIZE]);
  const outputs = await session.run({ [inputName]: tensor });
  const detections = decodeDetections(
    outputs[outputName],
    preparation,
    options.confidenceThreshold ?? DEFAULT_CONFIDENCE,
    options.iouThreshold ?? DEFAULT_IOU,
  );
  const directCrop = detections.length === 0
    && preparation.metadata.width / preparation.metadata.height >= 2.2
    && preparation.metadata.height <= 600;

  return {
    success: detections.length > 0,
    detections,
    directCrop,
    modelPath: getModelPath(),
    processingTimeMs: Date.now() - startedAt,
    image: { width: preparation.metadata.width, height: preparation.metadata.height },
  };
}

async function shutdownPlateDetector() {
  if (sessionPromise) {
    const session = await sessionPromise;
    if (session.release) await session.release();
    sessionPromise = null;
  }
}

module.exports = {
  detectPlate,
  getModelPath,
  shutdownPlateDetector,
};
