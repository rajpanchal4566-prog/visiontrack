#!/usr/bin/env node

const { initializeDatabase, getDb } = require('../database');

const cameraId = process.argv[2] || 'CAM-101';

initializeDatabase();
const db = getDb();
const camera = db.prepare('SELECT id, name, api_token, status, zone FROM cameras WHERE id = ?').get(cameraId);

if (!camera) {
  console.error(`Camera not found: ${cameraId}`);
  process.exit(1);
}

console.log(JSON.stringify({
  camera_id: camera.id,
  camera_name: camera.name,
  location_id: camera.zone,
  api_token: camera.api_token,
  status: camera.status,
}, null, 2));
