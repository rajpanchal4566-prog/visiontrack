// ============================================
// VisionTrack — OCR Image Preprocessor
// Modular image processing pipeline using sharp
// for optimal license plate OCR accuracy.
//
// Generates MULTIPLE preprocessing variants
// to maximize OCR accuracy across different
// image types (plate crops vs full vehicle photos).
// ============================================
const sharp = require('sharp');

const MAX_PLATE_CANDIDATES = 5;

/**
 * Resolve image input to a Buffer.
 * Accepts: Buffer, base64 string, data URI, or local file path.
 */
function resolveImageInput(input) {
  if (Buffer.isBuffer(input)) return input;

  if (typeof input === 'string') {
    // Data URI: data:image/jpeg;base64,/9j/4AAQ...
    const dataUriMatch = input.match(/^data:image\/[^;]+;base64,(.+)$/i);
    if (dataUriMatch) {
      return Buffer.from(dataUriMatch[1], 'base64');
    }

    // Raw base64 string (long enough to be an image)
    if (/^[a-z0-9+/\s]+=*$/i.test(input) && input.length > 100) {
      return Buffer.from(input.replace(/\s/g, ''), 'base64');
    }

    // File path — let sharp handle it directly
    return input;
  }

  return null;
}

/**
 * Validate that sharp can read the input image and get metadata.
 */
async function validateImage(imageInput) {
  const resolved = resolveImageInput(imageInput);
  if (!resolved) {
    throw new Error('Could not resolve image input to a processable format');
  }

  const metadata = await sharp(resolved).metadata().catch(() => null);
  if (!metadata || !metadata.width || !metadata.height) {
    throw new Error('Image could not be decoded or is corrupt');
  }

  return { resolved, metadata };
}

/**
 * Variant A: Balanced preprocessing
 * Best for: reasonably clear plate images
 * Pipeline: auto-orient → grayscale → resize → normalize contrast → light sharpen
 */
async function preprocessVariantA(imageBuffer, metadata) {
  let pipeline = sharp(imageBuffer).rotate(); // auto-orient based on EXIF

  pipeline = pipeline.grayscale();

  // Resize: upscale small images, downscale huge ones
  if (metadata.width < 300) {
    pipeline = pipeline.resize({ width: 400, kernel: sharp.kernel.lanczos3, withoutEnlargement: false });
  } else if (metadata.width > 1600) {
    pipeline = pipeline.resize({ width: 1200, withoutEnlargement: true });
  }

  pipeline = pipeline.normalize(); // stretch histogram for contrast
  pipeline = pipeline.sharpen({ sigma: 1.0 });

  return pipeline.png().toBuffer();
}

/**
 * Variant B: High contrast with moderate threshold
 * Best for: images with clear text but poor lighting
 * Pipeline: auto-orient → grayscale → resize → normalize → sharpen → threshold(160)
 */
async function preprocessVariantB(imageBuffer, metadata) {
  let pipeline = sharp(imageBuffer).rotate();
  pipeline = pipeline.grayscale();

  if (metadata.width < 300) {
    pipeline = pipeline.resize({ width: 400, kernel: sharp.kernel.lanczos3, withoutEnlargement: false });
  } else if (metadata.width > 1600) {
    pipeline = pipeline.resize({ width: 1200, withoutEnlargement: true });
  }

  pipeline = pipeline.normalize();
  pipeline = pipeline.sharpen({ sigma: 1.5 });
  pipeline = pipeline.threshold(160); // moderate binary threshold

  return pipeline.png().toBuffer();
}

/**
 * Variant C: Minimal preprocessing
 * Best for: already clear, cropped plate images
 * Pipeline: auto-orient → grayscale → resize only if too small
 */
async function preprocessVariantC(imageBuffer, metadata) {
  let pipeline = sharp(imageBuffer).rotate();
  pipeline = pipeline.grayscale();

  if (metadata.width < 200) {
    pipeline = pipeline.resize({ width: 300, kernel: sharp.kernel.lanczos3, withoutEnlargement: false });
  }

  return pipeline.png().toBuffer();
}

/**
 * Variant D: Enhanced with noise reduction
 * Best for: noisy or low-quality images
 * Pipeline: auto-orient → grayscale → resize → median denoise → normalize → sharpen
 */
async function preprocessVariantD(imageBuffer, metadata) {
  let pipeline = sharp(imageBuffer).rotate();
  pipeline = pipeline.grayscale();

  if (metadata.width < 300) {
    pipeline = pipeline.resize({ width: 400, kernel: sharp.kernel.lanczos3, withoutEnlargement: false });
  } else if (metadata.width > 1600) {
    pipeline = pipeline.resize({ width: 1200, withoutEnlargement: true });
  }

  pipeline = pipeline.median(3); // noise reduction
  pipeline = pipeline.normalize();
  pipeline = pipeline.sharpen({ sigma: 1.2 });

  return pipeline.png().toBuffer();
}

async function preprocessTightLineVariant(imageBuffer, metadata) {
  const insetX = Math.max(1, Math.round(metadata.width * 0.035));
  const insetY = Math.max(1, Math.round(metadata.height * 0.05));
  const width = Math.max(20, metadata.width - insetX * 2);
  const height = Math.max(12, metadata.height - insetY * 2);
  return sharp(imageBuffer)
    .extract({ left: insetX, top: insetY, width, height })
    .extend({ top: 6, bottom: 6, left: 10, right: 10, background: { r: 255, g: 255, b: 255 } })
    .resize({ width: 1600, kernel: sharp.kernel.lanczos3, withoutEnlargement: false })
    .grayscale()
    .normalize()
    .sharpen({ sigma: 1.0 })
    .png()
    .toBuffer();
}

/**
 * Generate all preprocessing variants for an image.
 *
 * @param {Buffer|string} imageInput - Raw image input
 * @returns {Promise<{ variants: Array<{name: string, buffer: Buffer}>, metadata: object }>}
 */
async function generatePreprocessingVariants(imageInput) {
  const { resolved, metadata } = await validateImage(imageInput);

  // Get the raw image as a Buffer for re-use across variants
  const imageBuffer = Buffer.isBuffer(resolved)
    ? resolved
    : await sharp(resolved).toBuffer();

  const variants = [];

  // Generate all variants, catching individual failures
  const variantFns = [
    { name: 'balanced', fn: preprocessVariantA },
    { name: 'high_contrast', fn: preprocessVariantB },
    { name: 'minimal', fn: preprocessVariantC },
    { name: 'tight_line', fn: preprocessTightLineVariant },
  ];

  for (const { name, fn } of variantFns) {
    try {
      const buffer = await fn(imageBuffer, metadata);
      variants.push({ name, buffer });
    } catch (err) {
      console.warn(`[OCR_PREPROCESS] Variant "${name}" failed: ${err.message}`);
    }
  }

  if (variants.length === 0) {
    throw new Error('All preprocessing variants failed');
  }

  return {
    variants,
    metadata: {
      width: metadata.width,
      height: metadata.height,
      format: metadata.format,
      channels: metadata.channels,
      size: imageBuffer.length,
    },
  };
}

/**
 * Find bright, plate-shaped connected regions in an image thumbnail.
 * This is deliberately conservative: it produces candidates for OCR rather
 * than claiming that a region is a plate.
 */
async function detectPlateRegions(imageInput) {
  const { resolved, metadata } = await validateImage(imageInput);
  const oriented = await sharp(resolved).rotate().toBuffer();
  const orientedMetadata = await sharp(oriented).metadata();
  const scale = Math.min(1, 1000 / orientedMetadata.width);
  const scanWidth = Math.max(240, Math.round(orientedMetadata.width * scale));
  const { data, info } = await sharp(oriented)
    .resize({ width: scanWidth, withoutEnlargement: true })
    .grayscale()
    .normalize()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const threshold = 170;
  const visited = new Uint8Array(info.width * info.height);
  const components = [];
  const indexOf = (x, y) => y * info.width + x;

  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const start = indexOf(x, y);
      if (visited[start] || data[start] < threshold) continue;

      const queue = [[x, y]];
      visited[start] = 1;
      let minX = x;
      let maxX = x;
      let minY = y;
      let maxY = y;
      let count = 0;

      while (queue.length) {
        const [currentX, currentY] = queue.pop();
        count += 1;
        minX = Math.min(minX, currentX);
        maxX = Math.max(maxX, currentX);
        minY = Math.min(minY, currentY);
        maxY = Math.max(maxY, currentY);

        for (const [nextX, nextY] of [[currentX - 1, currentY], [currentX + 1, currentY], [currentX, currentY - 1], [currentX, currentY + 1]]) {
          if (nextX < 0 || nextY < 0 || nextX >= info.width || nextY >= info.height) continue;
          const next = indexOf(nextX, nextY);
          if (!visited[next] && data[next] >= threshold) {
            visited[next] = 1;
            queue.push([nextX, nextY]);
          }
        }
      }

      const width = maxX - minX + 1;
      const height = maxY - minY + 1;
      const area = width * height;
      const fill = count / area;
      const aspect = width / height;
      if (width >= 35 && height >= 8 && aspect >= 1.8 && aspect <= 7 && area >= 500 && fill >= 0.18 && fill <= 1) {
        const aspectScore = Math.max(0, 1 - Math.abs(Math.log(aspect / 3.5)));
        const sizeScore = Math.min(1, area / (info.width * info.height * 0.08));
        components.push({ minX, minY, maxX, maxY, score: aspectScore * 60 + sizeScore * 25 + fill * 15 });
      }
    }
  }

  const scaleBack = 1 / scale;
  const candidates = components
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_PLATE_CANDIDATES)
    .map((candidate) => {
      const paddingX = Math.max(2, Math.round((candidate.maxX - candidate.minX + 1) * 0.10));
      const paddingY = Math.max(2, Math.round((candidate.maxY - candidate.minY + 1) * 0.10));
      const left = Math.max(0, Math.floor((candidate.minX - paddingX) * scaleBack));
      const top = Math.max(0, Math.floor((candidate.minY - paddingY) * scaleBack));
      const right = Math.min(orientedMetadata.width, Math.ceil((candidate.maxX + paddingX + 1) * scaleBack));
      const bottom = Math.min(orientedMetadata.height, Math.ceil((candidate.maxY + paddingY + 1) * scaleBack));
      return { x: left, y: top, width: right - left, height: bottom - top, score: Math.round(candidate.score * 10) / 10 };
    })
    .filter((candidate) => candidate.width >= 50 && candidate.height >= 15);

  const isLikelyPlateCrop = orientedMetadata.width / orientedMetadata.height >= 3
    && orientedMetadata.height <= 400;
  if (isLikelyPlateCrop) {
    candidates.unshift({ x: 0, y: 0, width: orientedMetadata.width, height: orientedMetadata.height, score: 100, direct: true });
  }

  const unique = [];
  for (const candidate of candidates) {
    if (!unique.some((item) => Math.abs(item.x - candidate.x) < 8 && Math.abs(item.y - candidate.y) < 8
      && Math.abs(item.width - candidate.width) < 12 && Math.abs(item.height - candidate.height) < 12)) {
      unique.push(candidate);
    }
  }

  const crops = [];
  for (const region of unique.slice(0, MAX_PLATE_CANDIDATES)) {
    try {
      const crop = await sharp(oriented).extract({ left: region.x, top: region.y, width: region.width, height: region.height }).png().toBuffer();
      crops.push({ ...region, buffer: crop });
    } catch {
      // Ignore invalid edge candidates and continue with the next one.
    }
  }

  return {
    candidates: crops,
    metadata: {
      width: orientedMetadata.width,
      height: orientedMetadata.height,
      format: orientedMetadata.format || metadata.format,
      channels: orientedMetadata.channels,
      size: oriented.length,
    },
  };
}

module.exports = {
  generatePreprocessingVariants,
  detectPlateRegions,
  validateImage,
  resolveImageInput,
};
