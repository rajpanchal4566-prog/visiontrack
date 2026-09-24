# VisionTrack — Feature 5A: Standalone Real-World Dataset Labeling Utility

A completely isolated, lightweight, and optional human-in-the-loop tool designed to convert raw plate crop images into verified ground-truth dataset samples.

---

## 1. Quick Start

### Start the Labeler Server:
```bash
# Basic startup (specify folder of plate crops)
node tools/labeler/server.js --input D:\TrafficCrops

# Or specify custom dataset output folder and port
node tools/labeler/server.js --input D:\TrafficCrops --output ./realworld_ocr_dataset --port 3333
```

Open your browser at:
```
http://localhost:3333
```

---

## 2. Human-in-the-Loop Verification Workflow

```
Raw Plate Crop Image
        ↓
Neural OCR Suggestion (Read-Only)
        ↓
Human Verification / Correction
        ↓
Ground-Truth Label & SHA-256 Hash Saved
        ↓
Next Image
```

> [!IMPORTANT]
> **Safety Rule:** OCR suggestions are provided strictly for operator speed. **Only human-verified text is ever written as ground truth.** If the operator edits or rejects the text, the human decision takes absolute precedence.

---

## 3. Keyboard Shortcuts

| Shortcut | Action | Description |
| :--- | :---: | :--- |
| **`Enter`** | **Verify & Next** | Confirms ground truth, saves image to `images/<hash>.png`, appends to `labels.csv`, advances to next image. |
| **`U`** (outside input) | **Mark Uncertain** | Flags plate as ambiguous/occluded and appends to `uncertain.csv`. |
| **`Delete`** / **`Alt+R`** | **Reject Crop** | Rejects non-plate, severe blur, or corrupt crop and appends to `rejected.csv`. |
| **`Tab`** | **Copy Suggestion** | Copies the neural OCR suggestion into the ground-truth input. |
| **`Ctrl+Z`** | **Undo Last** | Reverts the last action, removes it from the CSV, and returns to that image. |
| **`Ctrl+P`** / **`Ctrl+N`** | **Previous / Next** | Navigate back and forth between images without modifying labels. |

---

## 4. Output Dataset Structure (`realworld_ocr_dataset/`)

```
realworld_ocr_dataset/
├── images/
│   ├── 4a8b7c9d...png      # Normalized PNG crop named by SHA-256 hash
│   └── ...
├── labels.csv               # Human-verified ground-truth labels & metadata
├── uncertain.csv            # Ambiguous/partially occluded samples
├── rejected.csv             # Rejected non-plates or unusable crops
└── dataset_report.md        # Live summary of sample counts, state distributions, dimensions
```

### Schema: `labels.csv`
- `hash`: SHA-256 hash of the crop image
- `filename`: Original crop filename
- `ground_truth`: Human-verified uppercase alphanumeric plate text
- `source`: Data source (`real_world`)
- `width`: Crop width in pixels
- `height`: Crop height in pixels
- `aspect_ratio`: Width / Height ratio
- `ocr_suggestion`: The initial neural OCR suggestion (for calibration/error analysis)
- `operator_notes`: Optional operator comments
- `timestamp`: ISO-8601 creation timestamp

---

## 5. Deletion & Archival Safety

This utility is completely decoupled from VisionTrack production by architecture:
- Does NOT touch production OCR, Feature 1, Feature 2, or CCT-XS.
- Does NOT touch YOLO, RTSP, Video ANPR Studio, camera registration, or tracker.
- Does NOT touch the production database or dashboard.

**After creating your dataset, the entire `tools/labeler/` directory can be deleted or archived at any time with zero impact on VisionTrack.**
