const fs = require('fs');
const path = require('path');
const { getDb } = require('../server/database');
const { spawnFrameProcess } = require('../server/services/frameStream');
const { realtimeAnprPipeline } = require('../server/services/realtimeAnprPipeline');

const videoPath = path.join(__dirname, '..', 'server', 'uploads', 'media', 'test_vehicle_traffic.mp4');

async function testLiveRtspPipeline() {
  console.log('================================================================================');
  console.log('   LIVE RTSP PIPELINE: VEHICLE TRACKING & PER-FRAME DIAGNOSTIC BENCHMARK        ');
  console.log('================================================================================\n');

  const db = getDb();
  const camera = db.prepare("SELECT * FROM cameras WHERE rtsp_url IS NOT NULL LIMIT 1").get() || {
    id: 'CAM-98406F92',
    name: 'New Traffic ANPR Camera',
    zone: 'Zone-1',
    speed_limit_kmh: 50,
  };

  console.log(`Using Camera Node: ${camera.id} (${camera.name} · ${camera.zone})`);
  console.log(`Simulating stream ingestion through realtimeAnprPipeline (sourceType: 'rtsp')\n`);

  // Extract sampled frames at 2 FPS (500ms intervals) matching the real RTSP sampling rate
  const frames = [];
  await new Promise((resolve, reject) => {
    const child = spawnFrameProcess(videoPath, {
      fps: 2,
      onFrame: (buf) => frames.push(buf),
    });
    child.on('close', resolve);
    child.on('error', reject);
  });

  console.log(`Extracted ${frames.length} consecutive sampled frames for vehicle pass.\n`);

  const stageTimes = {
    resizeMs: [],
    vehicleDetMs: [],
    plateOcrMs: [],
    violationMs: [],
    trackingMs: [],
    persistAndBroadcastMs: [],
    totalMs: [],
  };

  const results = [];
  const startAll = Date.now();

  for (let i = 0; i < frames.length; i++) {
    const frameBuffer = frames[i];
    const frameStart = Date.now();

    const res = await realtimeAnprPipeline.processFrame(frameBuffer, {
      camera,
      cameraId: camera.id,
      sourceType: 'rtsp',
      emitSocket: false, // console benchmark
    });

    results.push(res);
  }

  // Feed 2 empty frames (or finalizeCamera) to simulate the vehicle departing the view
  console.log('\n--- Simulating Vehicle Exit (2 trailing frames without vehicle) ---');
  for (let exitFrame = 1; exitFrame <= 2; exitFrame++) {
    const blank = await require('sharp')({
      create: { width: 640, height: 480, channels: 3, background: { r: 30, g: 30, b: 30 } }
    }).jpeg().toBuffer();

    const exitRes = await realtimeAnprPipeline.processFrame(blank, {
      camera,
      cameraId: camera.id,
      sourceType: 'rtsp',
      emitSocket: false,
    });
    results.push(exitRes);
  }

  console.log('\n================================================================================');
  console.log('   PIPELINE EXECUTION SUMMARY & END-TO-END LATENCY AUDIT                        ');
  console.log('================================================================================');

  const detections = results.filter(r => r.detection);
  console.log(`Total Frames Processed:    ${results.length}`);
  console.log(`Finalized Detections:      ${detections.length} (Expected exactly 1 for the vehicle pass)`);
  if (detections.length > 0) {
    const d = detections[0].detection;
    console.log(`Authoritative Plate:       ${d.plate}`);
    console.log(`Winning OCR Reading:       ${d.ocr_text}`);
    console.log(`OCR Confidence Score:      ${((d.confidence || 0) * 100).toFixed(1)}%`);
    console.log(`Vehicle Type:              ${d.vehicle_type}`);
    console.log(`Snapshot Saved:            ${d.image_path}`);
    console.log(`Detection ID:              ${d.id}`);
  }
}

testLiveRtspPipeline().catch(console.error);
