# VisionTrack — Production Deployment Guide (Railway & Render)

This document provides complete instructions for deploying the **VisionTrack Central AI Engine & Traffic Intelligence Platform** to cloud hosting platforms like [Railway](https://railway.app) and [Render](https://render.com).

---

## 1. Architecture & Deployment Model

VisionTrack is a unified full-stack application:
- **Backend**: Node.js 20, Express 5, Socket.IO, Better-SQLite3, ONNX Runtime (CCT neural OCR, YOLOv8 vehicle & plate detection, YOLO11 seatbelt classification).
- **Video Ingestion**: FFmpeg pipeline extracting real-time MJPEG frames from RTSP camera streams and video files at 16 FPS.
- **Frontend**: Vite React SPA (compiled into static assets in `dist/` and served directly by the backend Express server).
- **Deployment Strategy**: Containerized via **Docker** (`Dockerfile`). A single Docker container hosts both the backend API/WebSocket engine and the compiled frontend dashboard.

---

## 2. Critical Production Considerations

### ⚠️ A. SQLite Persistence (MANDATORY Persistent Volume)
Railway and Render run applications in **ephemeral container environments**. Every time the application redeploys, crashes, or scales, the local filesystem is reset to the Docker image state.

> **CRITICAL**: If you do not attach a persistent disk, **your entire SQLite database (`anpr.db`) and all historical detections, audit logs, violations, and settings will be permanently destroyed on every redeploy.**

- **On Railway**:
  1. Add a **Persistent Volume** to your service.
  2. Set Mount Path: `/data`
  3. Set Environment Variable: `DB_PATH=/data/anpr.db`
- **On Render**:
  1. Go to service settings -> **Disks**.
  2. Click **Add Disk** (e.g., Name: `visiontrack-data`, Mount Path: `/data`, Size: 1GB or more).
  3. Set Environment Variable: `DB_PATH=/data/anpr.db`

### ⚠️ B. FFmpeg Availability
VisionTrack's RTSP ingestion (`server/services/rtspIngestion.js`) and video processing (`server/services/frameStream.js`) depend on the native `ffmpeg` binary.
- Standard Node.js buildpacks (Heroku/Render native) **do not** include FFmpeg by default.
- VisionTrack provides an official **`Dockerfile`** based on `node:20-bookworm-slim` that installs `ffmpeg` via Debian `apt-get`.
- **Always select "Dockerfile" deployment** on Railway or Render to ensure FFmpeg is available in the container `$PATH`.

### ⚠️ C. Mandatory `JWT_SECRET`
VisionTrack enforces strict authentication. The application **will refuse to start** and immediately exit with an error code if `JWT_SECRET` is not provided.
- Generate a cryptographically random string (e.g. `openssl rand -hex 32`) and set it as `JWT_SECRET`.

---

## 3. Required & Optional Environment Variables

| Variable Name | Required | Default Value | Description |
| :--- | :---: | :---: | :--- |
| **`JWT_SECRET`** | **YES** | *None (Refuses to start)* | Cryptographic secret for signing and verifying JSON Web Tokens. |
| **`PORT`** | Auto | `3001` | Listening HTTP port. Railway and Render inject this automatically. |
| **`DB_PATH`** | **YES (Prod)** | `./anpr.db` | Absolute path to SQLite database. Must point to persistent mount (e.g. `/data/anpr.db`). |
| **`ALLOWED_ORIGINS`** | Recommended | `*` (or localhost) | Comma-separated list of allowed frontend domains for CORS and Socket.IO. (e.g. `https://visiontrack.up.railway.app`). |
| **`CORS_ORIGIN`** | Optional | *Fallback to ALLOWED_ORIGINS* | Alias for `ALLOWED_ORIGINS`. |
| **`VITE_API_URL`** | Optional | *Empty (same origin)* | Build-time API origin. Leave empty if frontend is served by the Docker container. |
| **`DEBUG_ANPR`** | Optional | `false` | When `true`, enables verbose per-frame diagnostic terminal logs. Keep `false` in production to prevent log flooding. |
| **`DEBUG_OCR`** | Optional | `false` | When `true`, enables verbose per-call candidate text and normalization logs. Keep `false` in production. |
| **`FFMPEG_PATH`** | Optional | `ffmpeg` | Path to FFmpeg executable. In Docker, `ffmpeg` is globally installed in PATH. |
| **`ANPR_SAMPLE_FPS`** | Optional | `16` | Ingestion target frame rate for RTSP and media video processing. |
| **`CAMERA_PAYLOAD_LIMIT`** | Optional | `50mb` | Express JSON request body size limit for base64 image frames. |
| **`MEDIA_FILE_LIMIT_BYTES`** | Optional | `2147483648` (2GB) | Maximum uploaded video file size for media processing. |
| **`ONNX_NUM_THREADS`** | Optional | `4` | Number of intra-op threads allocated to ONNX Runtime inference sessions. |

---

## 4. Step-by-Step Railway Deployment

1. **Push to GitHub**:
   Ensure all tracked files (including models in `models/*.onnx`) are pushed to your GitHub repository.
2. **Create New Project on Railway**:
   - Go to [Railway Dashboard](https://railway.app/new).
   - Select **Deploy from GitHub repo** and choose your repository.
3. **Configure Service**:
   - Railway will automatically detect the root `Dockerfile`.
   - In **Settings** -> **Build**: verify Builder is set to **Dockerfile**.
4. **Attach Persistent Storage**:
   - Click **+ New** -> **Volume** (or inside service settings -> **Volumes**).
   - Set **Mount Path** to `/data`.
5. **Set Environment Variables**:
   In service **Variables**, add:
   ```env
   NODE_ENV=production
   JWT_SECRET=generate_a_random_32_character_hex_string
   DB_PATH=/data/anpr.db
   ALLOWED_ORIGINS=https://${{RAILWAY_PUBLIC_DOMAIN}}
   DEBUG_ANPR=false
   DEBUG_OCR=false
   ```
6. **Generate Public Domain**:
   - In service **Settings** -> **Networking**, click **Generate Domain**.
7. **Deploy & Verify**:
   - Railway will build the Docker container and start the service.
   - Test health endpoint: `https://your-domain.up.railway.app/health`

---

## 5. Step-by-Step Render Deployment

1. **Push to GitHub**:
   Ensure the repository is updated on GitHub.
2. **Create New Web Service on Render**:
   - Go to [Render Dashboard](https://dashboard.render.com).
   - Click **New +** -> **Web Service**.
   - Connect your GitHub repository.
3. **Select Runtime**:
   - Choose **Docker** (Render will use `Dockerfile`).
4. **Configure Persistent Disk**:
   - Under **Disks**, click **Add Disk**:
     - Name: `visiontrack-data`
     - Mount Path: `/data`
     - Size: `1 GB` (or larger)
5. **Configure Environment Variables**:
   Add the following under **Environment Variables**:
   ```env
   NODE_ENV=production
   JWT_SECRET=generate_a_random_32_character_hex_string
   DB_PATH=/data/anpr.db
   ALLOWED_ORIGINS=https://visiontrack.onrender.com
   DEBUG_ANPR=false
   DEBUG_OCR=false
   ```
6. **Deploy**:
   - Click **Create Web Service**.
   - Monitor the build logs to confirm Docker stage 1 (Vite frontend build) and stage 2 (FFmpeg install + production dependencies) succeed.
   - Access the dashboard at `https://your-app.onrender.com`.

---

## 6. ONNX Model Assets Verification

VisionTrack requires 6 pre-trained ONNX models located in `models/`:
- `models/license-plate-ocr-india-finetuned.onnx` (2.6 MB) — Indian plate character recognition.
- `models/license-plate-ocr.onnx` (3.3 MB) — Fallback neural plate OCR.
- `models/license-plate-yolov8.onnx` (12.2 MB) — Plate bounding box locator.
- `models/yolov8n.onnx` (12.8 MB) — Vehicle detection and classification.
- `models/helmet-yolov8.onnx` (12.1 MB) — Two-wheeler helmet compliance detector.
- `models/seatbelt-yolo11.onnx` (21.8 MB) — Four-wheeler seatbelt compliance classifier.

All files are strictly under 25 MB and are tracked directly in Git (`.gitignore` explicitly preserves them). They are copied into the container during Docker build (`COPY models/ ./models/`).

---

## 7. Health Checks & Verification Endpoints

After deployment, test the following endpoints to verify system operational health:

- **System Health**:
  ```bash
  curl -s https://your-deployment-domain/health
  # Response: {"status":"online","service":"visiontrack-server","uptime":...,"timestamp":"..."}
  ```
- **API Version & Database Status**:
  ```bash
  curl -s https://your-deployment-domain/api/health
  # Response: {"status":"online","uptime":...,"version":"1.0.0"}
  ```
- **Web Interface**:
  Open `https://your-deployment-domain/` in a browser. The compiled React dashboard should load with full real-time Socket.IO streaming support.
