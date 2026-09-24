# VisionTrack — OCR Processing Documentation

## Overview

VisionTrack includes an integrated OCR (Optical Character Recognition) pipeline for extracting license plate numbers from vehicle images. This enables the platform to process detections from non-ANPR cameras that send images without pre-recognized plate numbers.

## OCR Engine

| Property | Value |
|---|---|
| Engine | **Tesseract.js** v7 |
| Type | Local processing (WASM-based, no cloud API) |
| Language | English (trained data auto-downloaded on first use) |
| Image processing | **sharp** (libvips-based, fast native module) |
| Plate detection | **YOLOv8 ONNX** (`ml-debi/yolov8-license-plate-detection`) |
| Inference runtime | **onnxruntime-node** |
| Cost | Free, open-source |
| Platform | Windows, macOS, Linux |

### Why Tesseract.js?

- Runs entirely locally — no internet required after initial setup
- No paid API keys or cloud dependencies
- Pure JavaScript/WASM — no system-level Tesseract installation needed
- npm-installable with `npm install tesseract.js`
- Windows-compatible out of the box

## Plate Detector Model

Full vehicle images are never sent directly to Tesseract. The OCR service first
uses the local YOLOv8 plate detector, crops the returned bounding box with 10%
padding, and then sends only the crop through Sharp and Tesseract. Up to five
model candidates are considered.

The selected model is `ml-debi/yolov8-license-plate-detection`, downloaded from:

`https://huggingface.co/ml-debi/yolov8-license-plate-detection`

The repository declares the MIT license. The ONNX artifact is not committed to
source control. Place it at `models/license-plate-yolov8.onnx`, or set
`OCR_PLATE_MODEL_PATH` to an absolute or relative path before starting the
server. To download the pinned artifact manually:

```powershell
Invoke-WebRequest -UseBasicParsing `
  -Uri 'https://huggingface.co/ml-debi/yolov8-license-plate-detection/resolve/main/best.onnx?download=true' `
  -OutFile 'models/license-plate-yolov8.onnx'
```

The model input is `1x3x640x640`; the detector decodes its `1x5x8400`
single-class output, applies confidence filtering and non-maximum suppression,
then maps coordinates back to the original image.

## Installation

```bash
cd project/visiontrack
npm install
```

The OCR dependencies (`tesseract.js`, `sharp`, and `onnxruntime-node`) are automatically installed.

On first OCR request, Tesseract.js downloads trained language data (~4MB) and caches it locally in `server/.tesseract-cache/`. Subsequent requests reuse the cached data.

## How OCR Works

### Pipeline

```
Image Input
    │
    ▼
┌─────────────────────────┐
│   Image Resolution      │ ← Buffer, base64, data URI, file path, or URL
└────────────┬────────────┘
             │
             ▼
┌─────────────────────────┐
│   YOLOv8 Plate Detector │
│   ├─ Letterbox to 640   │
│   ├─ ONNX inference     │
│   ├─ Confidence filter  │
│   └─ NMS + crop boxes   │
└────────────┬────────────┘
             │
             ▼
┌─────────────────────────┐
│   Preprocessing (sharp) │
│   ├─ Grayscale          │
│   ├─ Resize/upscale     │
│   ├─ Contrast normalize │
│   ├─ Noise reduction    │
│   ├─ Sharpening         │
│   └─ Binary threshold   │
└────────────┬────────────┘
             │
             ▼
┌─────────────────────────┐
│   Tesseract.js OCR      │ ← Character whitelist: A-Z, 0-9
│   (PSM 7: single line)  │
└────────────┬────────────┘
            │
             ▼
┌─────────────────────────┐
│   Plate Normalizer      │
│   ├─ Strip noise chars  │
│   ├─ Uppercase          │
│   ├─ Positional fix     │ ← Only when it produces valid pattern
│   └─ Format validation  │
└────────────┬────────────┘
             │
             ▼
┌─────────────────────────┐
│   Result                │
│   ├─ plate              │
│   ├─ confidence         │
│   ├─ rawText            │
│   └─ processingTimeMs   │
└─────────────────────────┘
```

### Detection Flow Integration

When a detection event arrives at either ingestion endpoint:

1. **Plate provided by camera** → Plate is used directly. `source_type = 'camera_anpr'`, `ocr_status = 'skipped'`. No OCR processing.

2. **No plate, but image available** → OCR pipeline runs automatically. If successful: `source_type = 'ocr'`, `ocr_status = 'success'`. If failed: detection is rejected.

3. **No plate, no image** → Detection is rejected with error.

### Database Fields

| Field | Type | Description |
|---|---|---|
| `ocr_text` | TEXT | Raw OCR output text |
| `ocr_confidence` | REAL | OCR-specific confidence (0-1), separate from camera confidence |
| `ocr_status` | TEXT | `'success'`, `'failed'`, `'skipped'`, or NULL |
| `source_type` | TEXT | `'camera_anpr'` or `'ocr'` |

Existing detection records without these fields continue to work (NULL values).

## Supported Input Types

| Input Type | Example |
|---|---|
| File upload | multipart/form-data with `image` field |
| Base64 string | Raw base64-encoded image data |
| Data URI | `data:image/jpeg;base64,/9j/4AAQ...` |
| HTTP URL | `https://example.com/plate.jpg` |
| Local file path | `/uploads/detections/abc.jpg` |
| Buffer | Node.js Buffer object |

### Supported Image Formats

JPEG, PNG, WebP, BMP, GIF (via sharp)

## How to Test OCR

### Method 1: Dashboard UI

1. Start the server: `npm run server`
2. Start the frontend: `npm run dev`
3. Navigate to **Dashboard → OCR Test** in the sidebar
4. Upload a license plate image
5. Click **Run OCR**
6. View results: plate number, confidence, processing time

### Method 2: API (curl)

```bash
# Upload image file
curl -X POST http://localhost:3001/api/ocr/test \
  -F "image=@/path/to/plate-image.jpg"

# Send base64 in JSON
curl -X POST http://localhost:3001/api/ocr/test \
  -H "Content-Type: application/json" \
  -d '{"image": "data:image/jpeg;base64,/9j/4AAQ..."}'
```

### Method 3: Check OCR engine status

```bash
curl http://localhost:3001/api/ocr/status
```

Returns:
```json
{
  "engine": "tesseract.js",
  "status": "available",
  "supportedFormats": ["jpeg", "jpg", "png", "webp", "bmp", "gif"],
  "maxFileSize": "10MB"
}
```

## Troubleshooting

### OCR returns empty or incorrect text

- **Image quality**: Ensure the plate area is clearly visible, not blurry
- **Image size**: Very small images (<100px wide) may not OCR well. The preprocessor upscales to minimum 300px width.
- **Contrast**: Low contrast between plate text and background reduces accuracy
- **Angle**: Heavily skewed or rotated plates may not be recognized

### First request is slow

The first OCR request initializes the Tesseract.js worker and downloads trained language data (~4MB). Subsequent requests reuse the initialized worker and are faster.

### sharp installation fails

`sharp` uses native binaries (libvips). On most systems `npm install` handles this automatically. If it fails:

```bash
npm rebuild sharp
```

On Windows, ensure you have the Visual C++ Build Tools installed if npm can't fetch prebuilt binaries.

### Tesseract cache

Trained data is cached in `server/.tesseract-cache/`. If OCR behaves unexpectedly, try deleting this directory and restarting the server.

## Architecture Files

| File | Description |
|---|---|
| `server/services/ocrService.js` | Core OCR module with `processPlateImage()` |
| `server/services/plateDetector.js` | Reusable YOLOv8 ONNX plate detector and box decoder |
| `server/services/ocrPreprocessor.js` | Image preprocessing pipeline (sharp) |
| `server/services/plateNormalizer.js` | Plate text normalization and correction |
| `server/routes/ocr.js` | OCR test API endpoint (`POST /api/ocr/test`) |
| `src/pages/dashboard/OcrTest.jsx` | Frontend OCR test page |
| `src/pages/dashboard/OcrTest.css` | OCR test page styles |

The OCR test response also includes `detectorConfidence`, `ocrConfidence`,
`finalConfidence`, raw `candidates`, `candidateCount`, `candidateRegions`,
`plateRegion`, and per-stage `timings`. A normalized result is accepted at
reasonable OCR confidence, or when at least two independent preprocessing/PSM
attempts converge on the same valid Indian plate. Confidence values are never
raised by normalization.

## Limitations

- OCR accuracy depends heavily on image quality, lighting, and plate condition
- Tesseract.js is a general-purpose OCR engine, not specifically trained for license plates
- Very dirty, damaged, or obscured plates may not be recognized
- Processing time is typically 500ms-3s depending on image size and system performance
- The plate normalizer has Indian plate format knowledge but works with any alphanumeric plate
- OCR confidence values from Tesseract are character-level averages, not plate-level accuracy measures
