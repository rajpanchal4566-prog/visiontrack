# VisionTrack ANPR Platform

AI-powered Automatic Number Plate Recognition and multi-camera traffic intelligence platform.

## Status
Production / Active Development

## Technology Stack
- **Frontend**: React, Vite, Tailwind/Vanilla CSS, Lucide icons, Recharts, Leaflet GIS Maps
- **Backend**: Node.js, Express, Socket.IO, Better-SQLite3
- **Computer Vision & Neural Models**: 
  - ONNX Runtime (`onnxruntime-node`)
  - YOLOv8 Vehicle & License Plate Detection
  - CCT-XS & Indian RTO-finetuned Plate OCR
  - YOLOv8 Helmet & YOLO11 Seatbelt Violation Detectors
- **Video Ingestion**: FFmpeg pipeline for RTSP streams and video files

---

## 🚀 Running Locally

### 1. Install Dependencies
```bash
npm install
```

### 2. Start the Backend API & Computer Vision Server
```bash
npm run server
```
> The API server runs at **http://localhost:3001**.
> On first run, it automatically initializes SQLite tables and seeds baseline cameras and demo validation records.

### 3. Start the Frontend Dashboard (in a separate terminal)
```bash
npm run dev
```
> The dashboard runs at **http://localhost:5173**.

---

## 🔑 Default Administrator Credentials
On a fresh installation, a default administrator account is automatically created:
- **Email**: `admin@visiontrack.io`
- **Password**: `admin123`

*(You can also click **"CREATE ACCOUNT"** on the login screen to register your own custom organization.)*

---

## 🧪 Testing & Verification
```bash
# Run unit test suite
node --test server/services/*.test.js

# Build production bundle
npm run build
```
