/**
 * VisionTrack — Feature 5A: Standalone Real-World Dataset Labeling Utility
 *
 * A completely isolated tool outside the VisionTrack production pipeline.
 * Converts raw plate crop images into verified ground-truth dataset samples
 * through a fast human-in-the-loop verification interface.
 *
 * Usage:
 *   node tools/labeler/server.js --input <path_to_crops_folder> [--output realworld_ocr_dataset] [--port 3333]
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');

// Optional read-only OCR suggestion service
let ocrService = null;
try {
  ocrService = require('../../server/services/plateEnhancementService');
} catch (err) {
  console.warn('[Labeler] Note: plateEnhancementService not loaded; OCR suggestions will be disabled.');
}

// -----------------------------------------------------------------------------
// CLI Argument Parsing
// -----------------------------------------------------------------------------
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    input: '',
    output: path.resolve(process.cwd(), 'realworld_ocr_dataset'),
    port: 3333,
    ocrModel: path.resolve(process.cwd(), 'models', 'license-plate-ocr-india-finetuned.onnx'),
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--input' || arg === '-i') {
      options.input = args[++i];
    } else if (arg === '--output' || arg === '-o') {
      options.output = path.resolve(process.cwd(), args[++i]);
    } else if (arg === '--port' || arg === '-p') {
      options.port = parseInt(args[++i], 10) || 3333;
    } else if (arg === '--ocr-model' || arg === '-m') {
      options.ocrModel = path.resolve(process.cwd(), args[++i]);
    }
  }

  return options;
}

const config = parseArgs();

if (config.help) {
  console.log(`
VisionTrack — Feature 5A: Standalone Real-World Dataset Labeling Utility

Usage:
  node tools/labeler/server.js [options]

Options:
  --input, -i <path>      Directory containing raw plate crops (required or defaults to current dir)
  --output, -o <path>     Target dataset directory (default: realworld_ocr_dataset)
  --port, -p <number>     Server port (default: 3333)
  --ocr-model, -m <path>  Path to ONNX OCR model for suggestions
  --help, -h              Display this help message

Example:
  node tools/labeler/server.js --input D:\\TrafficCrops --output ./realworld_ocr_dataset --port 3333
`);
  process.exit(0);
}

// Set OCR Model Path for read-only inference if specified
if (config.ocrModel && fs.existsSync(config.ocrModel)) {
  process.env.OCR_MODEL_PATH = config.ocrModel;
}

// -----------------------------------------------------------------------------
// Dataset Directory & Manifests Initialization
// -----------------------------------------------------------------------------
const DATASET_DIR = config.output;
const IMAGES_DIR = path.join(DATASET_DIR, 'images');
const LABELS_CSV = path.join(DATASET_DIR, 'labels.csv');
const UNCERTAIN_CSV = path.join(DATASET_DIR, 'uncertain.csv');
const REJECTED_CSV = path.join(DATASET_DIR, 'rejected.csv');
const REPORT_MD = path.join(DATASET_DIR, 'dataset_report.md');

function ensureDirectories() {
  if (!fs.existsSync(DATASET_DIR)) fs.mkdirSync(DATASET_DIR, { recursive: true });
  if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR, { recursive: true });

  const labelsHeader = 'hash,filename,ground_truth,source,width,height,aspect_ratio,ocr_suggestion,operator_notes,timestamp\n';
  if (!fs.existsSync(LABELS_CSV)) fs.writeFileSync(LABELS_CSV, labelsHeader, 'utf-8');

  const uncertainHeader = 'hash,filename,suspected_text,source,width,height,reason,timestamp\n';
  if (!fs.existsSync(UNCERTAIN_CSV)) fs.writeFileSync(UNCERTAIN_CSV, uncertainHeader, 'utf-8');

  const rejectedHeader = 'hash,filename,source,width,height,rejection_reason,timestamp\n';
  if (!fs.existsSync(REJECTED_CSV)) fs.writeFileSync(REJECTED_CSV, rejectedHeader, 'utf-8');
}

ensureDirectories();

// -----------------------------------------------------------------------------
// Image Scanning
// -----------------------------------------------------------------------------
const SUPPORTED_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp']);

function scanInputImages(inputPath) {
  if (!inputPath || !fs.existsSync(inputPath)) {
    return [];
  }
  const stat = fs.statSync(inputPath);
  if (stat.isFile()) {
    const ext = path.extname(inputPath).toLowerCase();
    return SUPPORTED_EXTS.has(ext) ? [inputPath] : [];
  }

  const results = [];
  function walk(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (SUPPORTED_EXTS.has(ext)) {
          results.push(full);
        }
      }
    }
  }
  walk(inputPath);
  return results.sort();
}

let imageFiles = scanInputImages(config.input);
console.log(`[Labeler] Found ${imageFiles.length} images in ${config.input || '(no input folder specified)'}`);

// -----------------------------------------------------------------------------
// Existing Labeled Hashes Lookup
// -----------------------------------------------------------------------------
function loadExistingHashes() {
  const verifiedHashes = new Set();
  const uncertainHashes = new Set();
  const rejectedHashes = new Set();

  function parseCsvHashes(filePath, set) {
    if (!fs.existsSync(filePath)) return;
    const lines = fs.readFileSync(filePath, 'utf-8').split(/\r?\n/).filter(l => l.trim().length > 0);
    for (let i = 1; i < lines.length; i++) {
      const firstComma = lines[i].indexOf(',');
      if (firstComma > 0) {
        const h = lines[i].substring(0, firstComma).replace(/^"|"$/g, '').trim();
        if (h) set.add(h);
      }
    }
  }

  parseCsvHashes(LABELS_CSV, verifiedHashes);
  parseCsvHashes(UNCERTAIN_CSV, uncertainHashes);
  parseCsvHashes(REJECTED_CSV, rejectedHashes);

  return { verifiedHashes, uncertainHashes, rejectedHashes };
}

let { verifiedHashes, uncertainHashes, rejectedHashes } = loadExistingHashes();
let actionHistory = []; // For Undo functionality

// -----------------------------------------------------------------------------
// Report Generator
// -----------------------------------------------------------------------------
function generateDatasetReport() {
  const { verifiedHashes, uncertainHashes, rejectedHashes } = loadExistingHashes();
  
  let labelLines = [];
  if (fs.existsSync(LABELS_CSV)) {
    labelLines = fs.readFileSync(LABELS_CSV, 'utf-8').split(/\r?\n/).filter(l => l.trim().length > 0).slice(1);
  }

  const stateCounts = {};
  let totalWidth = 0;
  let totalHeight = 0;
  let singleLineCount = 0;
  let twoLineCount = 0;

  for (const line of labelLines) {
    // CSV format: hash,filename,ground_truth,source,width,height,aspect_ratio,ocr_suggestion,operator_notes,timestamp
    const cols = line.split(',');
    if (cols.length >= 3) {
      const gt = cols[2].replace(/^"|"$/g, '').trim().toUpperCase();
      const state = gt.substring(0, 2);
      if (/^[A-Z]{2}$/.test(state)) {
        stateCounts[state] = (stateCounts[state] || 0) + 1;
      }
      const w = parseInt(cols[4], 10) || 0;
      const h = parseInt(cols[5], 10) || 0;
      totalWidth += w;
      totalHeight += h;
      if (h > 0 && (w / h) < 2.5) {
        twoLineCount++;
      } else {
        singleLineCount++;
      }
    }
  }

  const totalVerified = verifiedHashes.size;
  const avgW = totalVerified > 0 ? (totalWidth / totalVerified).toFixed(1) : 0;
  const avgH = totalVerified > 0 ? (totalHeight / totalVerified).toFixed(1) : 0;

  const sortedStates = Object.entries(stateCounts).sort((a, b) => b[1] - a[1]);

  const report = `# Real-World ANPR Dataset Report

**Generated:** ${new Date().toISOString()}  
**Dataset Directory:** \`${DATASET_DIR}\`  

---

## 1. Summary Statistics

| Category | Count | Percentage |
| :--- | :---: | :---: |
| **Human-Verified Samples** | **${totalVerified}** | **${((totalVerified / (totalVerified + uncertainHashes.size + rejectedHashes.size || 1)) * 100).toFixed(1)}%** |
| **Uncertain Samples** | **${uncertainHashes.size}** | ${((uncertainHashes.size / (totalVerified + uncertainHashes.size + rejectedHashes.size || 1)) * 100).toFixed(1)}% |
| **Rejected Samples** | **${rejectedHashes.size}** | ${((rejectedHashes.size / (totalVerified + uncertainHashes.size + rejectedHashes.size || 1)) * 100).toFixed(1)}% |
| **Total Processed** | **${totalVerified + uncertainHashes.size + rejectedHashes.size}** | 100.0% |

---

## 2. Geometry & Layout

| Metric | Value |
| :--- | :---: |
| **Average Crop Dimensions** | ${avgW} × ${avgH} px |
| **Single-Line Plates** | ${singleLineCount} (${totalVerified > 0 ? ((singleLineCount / totalVerified) * 100).toFixed(1) : 0}%) |
| **Two-Line (Square) Plates** | ${twoLineCount} (${totalVerified > 0 ? ((twoLineCount / totalVerified) * 100).toFixed(1) : 0}%) |

---

## 3. State Code Distribution (Verified)

${sortedStates.length === 0 ? '_No state codes recorded yet._' : `
| State Code | Count | Share |
| :---: | :---: | :---: |
${sortedStates.map(([st, c]) => `| **${st}** | ${c} | ${((c / totalVerified) * 100).toFixed(1)}% |`).join('\n')}
`}

---

## 4. File Manifests
- Verified Labels: \`labels.csv\`
- Uncertain Records: \`uncertain.csv\`
- Rejected Records: \`rejected.csv\`
- Cropped Images: \`images/<sha256>.png\`
`;

  fs.writeFileSync(REPORT_MD, report, 'utf-8');
  return report;
}

// -----------------------------------------------------------------------------
// Image Metadata & OCR Cache
// -----------------------------------------------------------------------------
const ocrCache = new Map();

async function getImageInfo(filePath) {
  const buf = fs.readFileSync(filePath);
  const hash = crypto.createHash('sha256').update(buf).digest('hex');
  const meta = await sharp(buf).metadata();
  
  let ocrSuggestion = '';
  let ocrConfidence = 0;

  if (ocrCache.has(hash)) {
    const cached = ocrCache.get(hash);
    ocrSuggestion = cached.plate;
    ocrConfidence = cached.confidence;
  } else if (ocrService && typeof ocrService.enhanceAndRecognizePlate === 'function') {
    try {
      const res = await ocrService.enhanceAndRecognizePlate(buf);
      ocrSuggestion = (res.plate || '').trim().toUpperCase();
      ocrConfidence = res.confidence || 0;
      ocrCache.set(hash, { plate: ocrSuggestion, confidence: ocrConfidence });
    } catch (err) {
      // OCR suggestion failed silently; leave empty
    }
  }

  const isVerified = verifiedHashes.has(hash);
  const isUncertain = uncertainHashes.has(hash);
  const isRejected = rejectedHashes.has(hash);

  return {
    filePath,
    filename: path.basename(filePath),
    hash,
    width: meta.width || 0,
    height: meta.height || 0,
    aspectRatio: meta.height ? Number((meta.width / meta.height).toFixed(2)) : 0,
    ocrSuggestion,
    ocrConfidence,
    isVerified,
    isUncertain,
    isRejected,
  };
}

// Current pointer
let currentIndex = 0;

// Skip already-processed images on startup
function findFirstUnprocessedIndex() {
  for (let i = 0; i < imageFiles.length; i++) {
    const filePath = imageFiles[i];
    try {
      const buf = fs.readFileSync(filePath);
      const h = crypto.createHash('sha256').update(buf).digest('hex');
      if (!verifiedHashes.has(h) && !uncertainHashes.has(h) && !rejectedHashes.has(h)) {
        return i;
      }
    } catch (e) {}
  }
  return 0;
}

currentIndex = findFirstUnprocessedIndex();

// -----------------------------------------------------------------------------
// HTTP Server & API Routes
// -----------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    // API: Session Info
    if (pathname === '/api/session' && req.method === 'GET') {
      const totalProcessed = verifiedHashes.size + uncertainHashes.size + rejectedHashes.size;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        currentIndex,
        totalImages: imageFiles.length,
        verifiedCount: verifiedHashes.size,
        uncertainCount: uncertainHashes.size,
        rejectedCount: rejectedHashes.size,
        totalProcessed,
        inputDir: config.input,
        outputDir: config.output,
      }));
      return;
    }

    // API: Set Input Directory
    if (pathname === '/api/set-input' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (data.inputDir && fs.existsSync(data.inputDir)) {
            config.input = data.inputDir;
            imageFiles = scanInputImages(config.input);
            const reloaded = loadExistingHashes();
            verifiedHashes = reloaded.verifiedHashes;
            uncertainHashes = reloaded.uncertainHashes;
            rejectedHashes = reloaded.rejectedHashes;
            currentIndex = findFirstUnprocessedIndex();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, count: imageFiles.length, currentIndex }));
          } else {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Directory does not exist' }));
          }
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: e.message }));
        }
      });
      return;
    }

    // API: Current Image
    if (pathname === '/api/image/current' && req.method === 'GET') {
      if (imageFiles.length === 0 || currentIndex >= imageFiles.length) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ done: true, totalImages: imageFiles.length }));
        return;
      }

      const filePath = imageFiles[currentIndex];
      const info = await getImageInfo(filePath);
      const buf = fs.readFileSync(filePath);
      const base64 = buf.toString('base64');
      const ext = path.extname(filePath).toLowerCase();
      const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ...info,
        index: currentIndex,
        total: imageFiles.length,
        imageData: `data:${mime};base64,${base64}`,
      }));
      return;
    }

    // API: Label Action (VERIFY / UNCERTAIN / REJECT / SKIP)
    if (pathname === '/api/label' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          const payload = JSON.parse(body);
          const { action, groundTruth, notes, reason } = payload;
          
          if (currentIndex < imageFiles.length) {
            const filePath = imageFiles[currentIndex];
            const buf = fs.readFileSync(filePath);
            const hash = crypto.createHash('sha256').update(buf).digest('hex');
            const meta = await sharp(buf).metadata();
            const filename = path.basename(filePath);
            const ts = new Date().toISOString();

            if (action === 'VERIFY') {
              const cleanedGt = (groundTruth || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
              if (!cleanedGt) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Ground truth text cannot be empty for VERIFY' }));
                return;
              }

              // Save normalized PNG into images/<hash>.png
              const targetPng = path.join(IMAGES_DIR, `${hash}.png`);
              if (!fs.existsSync(targetPng)) {
                await sharp(buf).png().toFile(targetPng);
              }

              // Append to labels.csv
              const ocrSug = payload.ocrSuggestion || '';
              const row = `"${hash}","${filename}","${cleanedGt}","real_world",${meta.width},${meta.height},${meta.height ? (meta.width / meta.height).toFixed(2) : 0},"${ocrSug}","${(notes || '').replace(/"/g, '""')}","${ts}"\n`;
              fs.appendFileSync(LABELS_CSV, row, 'utf-8');
              verifiedHashes.add(hash);
              actionHistory.push({ type: 'VERIFY', hash, index: currentIndex, filePath });

            } else if (action === 'UNCERTAIN') {
              const suspected = (groundTruth || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
              const row = `"${hash}","${filename}","${suspected}","real_world",${meta.width},${meta.height},"${(reason || notes || 'ambiguous').replace(/"/g, '""')}","${ts}"\n`;
              fs.appendFileSync(UNCERTAIN_CSV, row, 'utf-8');
              uncertainHashes.add(hash);
              actionHistory.push({ type: 'UNCERTAIN', hash, index: currentIndex, filePath });

            } else if (action === 'REJECT') {
              const row = `"${hash}","${filename}","real_world",${meta.width},${meta.height},"${(reason || notes || 'rejected').replace(/"/g, '""')}","${ts}"\n`;
              fs.appendFileSync(REJECTED_CSV, row, 'utf-8');
              rejectedHashes.add(hash);
              actionHistory.push({ type: 'REJECT', hash, index: currentIndex, filePath });
            }

            // Advance index
            if (currentIndex < imageFiles.length - 1) {
              currentIndex++;
            }
          }

          // Update report live
          generateDatasetReport();

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            currentIndex,
            verifiedCount: verifiedHashes.size,
            uncertainCount: uncertainHashes.size,
            rejectedCount: rejectedHashes.size,
          }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // API: Navigate (jump to index / next / prev)
    if (pathname === '/api/navigate' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const payload = JSON.parse(body);
          if (payload.index !== undefined) {
            currentIndex = Math.max(0, Math.min(imageFiles.length - 1, payload.index));
          } else if (payload.direction === 'prev') {
            currentIndex = Math.max(0, currentIndex - 1);
          } else if (payload.direction === 'next') {
            currentIndex = Math.min(imageFiles.length - 1, currentIndex + 1);
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ currentIndex }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    // API: Undo Last Action
    if (pathname === '/api/undo' && req.method === 'POST') {
      if (actionHistory.length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No actions to undo' }));
        return;
      }
      const last = actionHistory.pop();
      if (last.type === 'VERIFY') {
        verifiedHashes.delete(last.hash);
        // Remove from labels.csv
        const lines = fs.readFileSync(LABELS_CSV, 'utf-8').split(/\r?\n/).filter(l => l.trim().length > 0);
        const filtered = [lines[0], ...lines.slice(1).filter(l => !l.startsWith(`"${last.hash}"`))];
        fs.writeFileSync(LABELS_CSV, filtered.join('\n') + '\n', 'utf-8');
      } else if (last.type === 'UNCERTAIN') {
        uncertainHashes.delete(last.hash);
        const lines = fs.readFileSync(UNCERTAIN_CSV, 'utf-8').split(/\r?\n/).filter(l => l.trim().length > 0);
        const filtered = [lines[0], ...lines.slice(1).filter(l => !l.startsWith(`"${last.hash}"`))];
        fs.writeFileSync(UNCERTAIN_CSV, filtered.join('\n') + '\n', 'utf-8');
      } else if (last.type === 'REJECT') {
        rejectedHashes.delete(last.hash);
        const lines = fs.readFileSync(REJECTED_CSV, 'utf-8').split(/\r?\n/).filter(l => l.trim().length > 0);
        const filtered = [lines[0], ...lines.slice(1).filter(l => !l.startsWith(`"${last.hash}"`))];
        fs.writeFileSync(REJECTED_CSV, filtered.join('\n') + '\n', 'utf-8');
      }

      currentIndex = last.index;
      generateDatasetReport();

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        undone: last,
        currentIndex,
        verifiedCount: verifiedHashes.size,
        uncertainCount: uncertainHashes.size,
        rejectedCount: rejectedHashes.size,
      }));
      return;
    }

    // API: Export / Refresh Report
    if (pathname === '/api/report' && req.method === 'GET') {
      const report = generateDatasetReport();
      res.writeHead(200, { 'Content-Type': 'text/markdown' });
      res.end(report);
      return;
    }

    // Static Files: Serve tools/labeler/public/
    let filePath = path.join(__dirname, 'public', pathname === '/' ? 'index.html' : pathname);
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      const contentTypes = {
        '.html': 'text/html',
        '.css': 'text/css',
        '.js': 'application/javascript',
        '.json': 'application/json',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.svg': 'image/svg+xml',
      };
      res.writeHead(200, { 'Content-Type': contentTypes[ext] || 'text/plain' });
      res.end(fs.readFileSync(filePath));
      return;
    }

    // Fallback: 404
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: error.message }));
  }
});

server.listen(config.port, () => {
  console.log('==================================================');
  console.log(`VisionTrack Standalone Labeler running on:`);
  console.log(`  http://localhost:${config.port}`);
  console.log(`Dataset output folder:`);
  console.log(`  ${config.output}`);
  console.log(`Input crops folder:`);
  console.log(`  ${config.input || '(none specified — use UI to set or pass --input)'}`);
  console.log('==================================================');
});
