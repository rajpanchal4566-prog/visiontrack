/**
 * Self-test script for Feature 5A: Standalone Dataset Labeling Utility
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const TEST_DIR = path.resolve(__dirname, 'test_scratch');
const CROPS_DIR = path.join(TEST_DIR, 'crops');
const DATASET_DIR = path.join(TEST_DIR, 'test_dataset');
const TEST_PORT = 3388;

// Create dummy plate crops
if (!fs.existsSync(CROPS_DIR)) fs.mkdirSync(CROPS_DIR, { recursive: true });
if (fs.existsSync(DATASET_DIR)) fs.rmSync(DATASET_DIR, { recursive: true, force: true });

// Copy or create 3 dummy images
const sharp = require('sharp');

async function setupTestImages() {
  await sharp({
    create: {
      width: 160,
      height: 48,
      channels: 3,
      background: { r: 255, g: 255, b: 255 }
    }
  }).png().toFile(path.join(CROPS_DIR, 'crop_sample1.png'));

  await sharp({
    create: {
      width: 140,
      height: 44,
      channels: 3,
      background: { r: 200, g: 200, b: 200 }
    }
  }).png().toFile(path.join(CROPS_DIR, 'crop_sample2.png'));

  await sharp({
    create: {
      width: 100,
      height: 60,
      channels: 3,
      background: { r: 150, g: 150, b: 150 }
    }
  }).png().toFile(path.join(CROPS_DIR, 'crop_sample3.png'));
}

function request(options, data) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, headers: res.headers, data: body.startsWith('{') || body.startsWith('[') ? JSON.parse(body) : body });
        } catch (e) {
          resolve({ status: res.statusCode, headers: res.headers, data: body });
        }
      });
    });
    req.on('error', reject);
    if (data) req.write(typeof data === 'string' ? data : JSON.stringify(data));
    req.end();
  });
}

async function runTest() {
  console.log('1. Setting up test images in', CROPS_DIR);
  await setupTestImages();

  console.log('2. Launching labeler server on port', TEST_PORT);
  const serverProc = spawn('node', [
    path.join(__dirname, 'server.js'),
    '--input', CROPS_DIR,
    '--output', DATASET_DIR,
    '--port', String(TEST_PORT),
  ], { stdio: 'pipe' });

  serverProc.stdout.on('data', (d) => console.log('[Server stdout]', d.toString().trim()));
  serverProc.stderr.on('data', (d) => console.error('[Server stderr]', d.toString().trim()));

  // Wait 1.5s for server to start
  await new Promise(r => setTimeout(r, 1500));

  try {
    // 3. Test GET /api/session
    console.log('3. Testing GET /api/session...');
    const sessionRes = await request({
      hostname: 'localhost',
      port: TEST_PORT,
      path: '/api/session',
      method: 'GET',
    });
    console.log('   Session response:', sessionRes.data);
    if (sessionRes.data.totalImages !== 3) throw new Error(`Expected 3 total images, got ${sessionRes.data.totalImages}`);

    // 4. Test GET /api/image/current
    console.log('4. Testing GET /api/image/current...');
    const imgRes = await request({
      hostname: 'localhost',
      port: TEST_PORT,
      path: '/api/image/current',
      method: 'GET',
    });
    console.log('   Current image filename:', imgRes.data.filename, 'hash:', imgRes.data.hash);
    if (!imgRes.data.hash) throw new Error('Missing hash in image info');

    // 5. Test POST /api/label (VERIFY)
    console.log('5. Testing POST /api/label (VERIFY: DL01AB1234)...');
    const labelRes = await request({
      hostname: 'localhost',
      port: TEST_PORT,
      path: '/api/label',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, {
      action: 'VERIFY',
      groundTruth: 'DL01AB1234',
      ocrSuggestion: 'DL01AB1234',
      notes: 'Test sample 1 verified',
    });
    console.log('   Verify response:', labelRes.data);
    if (!labelRes.data.success || labelRes.data.verifiedCount !== 1) {
      throw new Error('Verification failed');
    }

    // 6. Test POST /api/label (UNCERTAIN)
    console.log('6. Testing POST /api/label (UNCERTAIN: MH12CD5678)...');
    const uncRes = await request({
      hostname: 'localhost',
      port: TEST_PORT,
      path: '/api/label',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, {
      action: 'UNCERTAIN',
      groundTruth: 'MH12CD5678',
      reason: 'Partially occluded',
    });
    console.log('   Uncertain response:', uncRes.data);
    if (!uncRes.data.success || uncRes.data.uncertainCount !== 1) {
      throw new Error('Uncertain action failed');
    }

    // 7. Test POST /api/label (REJECT)
    console.log('7. Testing POST /api/label (REJECT)...');
    const rejRes = await request({
      hostname: 'localhost',
      port: TEST_PORT,
      path: '/api/label',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, {
      action: 'REJECT',
      reason: 'Not a plate crop',
    });
    console.log('   Reject response:', rejRes.data);
    if (!rejRes.data.success || rejRes.data.rejectedCount !== 1) {
      throw new Error('Reject action failed');
    }

    // 8. Test Output files existence
    console.log('8. Verifying output dataset files in', DATASET_DIR);
    const labelsCsv = path.join(DATASET_DIR, 'labels.csv');
    const uncCsv = path.join(DATASET_DIR, 'uncertain.csv');
    const rejCsv = path.join(DATASET_DIR, 'rejected.csv');
    const reportMd = path.join(DATASET_DIR, 'dataset_report.md');
    const imagesDir = path.join(DATASET_DIR, 'images');

    if (!fs.existsSync(labelsCsv)) throw new Error('labels.csv missing');
    if (!fs.existsSync(uncCsv)) throw new Error('uncertain.csv missing');
    if (!fs.existsSync(rejCsv)) throw new Error('rejected.csv missing');
    if (!fs.existsSync(reportMd)) throw new Error('dataset_report.md missing');
    const savedImages = fs.readdirSync(imagesDir);
    console.log('   Saved images count:', savedImages.length);
    if (savedImages.length !== 1) throw new Error('Expected 1 saved image in images/');

    console.log('   labels.csv content:\n' + fs.readFileSync(labelsCsv, 'utf-8'));
    console.log('   dataset_report.md snippet:\n' + fs.readFileSync(reportMd, 'utf-8').substring(0, 400));

    // 9. Test POST /api/undo
    console.log('9. Testing POST /api/undo...');
    const undoRes = await request({
      hostname: 'localhost',
      port: TEST_PORT,
      path: '/api/undo',
      method: 'POST',
    });
    console.log('   Undo response:', undoRes.data);
    if (!undoRes.data.success || undoRes.data.rejectedCount !== 0) {
      throw new Error('Undo failed');
    }

    console.log('==================================================');
    console.log('ALL SELF-TESTS PASSED SUCCESSFULLY!');
    console.log('==================================================');
  } finally {
    serverProc.kill();
    // Clean up test scratch
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    }
  }
}

runTest().catch(err => {
  console.error('Self-test failed:', err);
  process.exit(1);
});
