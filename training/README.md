# FastPlateOCR CCT-XS Fine-Tuning for Indian License Plates (Feature 3B)

This workspace provides the isolated domain-adaptation training pipeline for fine-tuning the Compact Convolutional Transformer Extra-Small (CCT-XS v2) model on Indian license plates.

---

## 1. Directory Structure

```
training/
├── README.md                               # This documentation
├── config/
│   ├── cct_xs_v2_model_config.yaml         # Official CCT-XS v2 architecture specification
│   └── cct_xs_v2_plate_config.yaml         # Plate configuration (64x128 RGB, 10 slots, 37 chars)
├── pretrained/
│   └── cct_xs_v2_global.keras              # Pretrained checkpoint from FastPlateOCR release
├── scripts/
│   ├── dataset.py                          # Data loader with mild traffic-robust augmentations
│   ├── train.py                            # Conservative fine-tuning runner
│   ├── export_onnx.py                      # ONNX exporter and numerical parity verifier
│   └── evaluate_splits.py                  # Evaluation script for validation and test splits
└── runs/                                   # Run outputs, checkpoints, and logs
```

---

## 2. Dataset

Dataset path: `D:\Download\ANPR_OCR_TRAINING_DATASET`
- `train.csv`: 11,934 samples (70.0%)
- `validation.csv`: 2,557 samples (15.0%)
- `test.csv`: 2,558 samples (15.0%)
- Split seed: 42 (deterministic)
- Input image dimensions: 512x128 PNG (resized during preprocessing to 128x64)
- Alphabet: `0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_` (37 classes: 36 alphanumerics + padding `_`)

### Benchmark Quarantine
The 1,696 real-world Indian license plate crops in `D:\Download\ANPR_BENCHMARK\` are **strictly quarantined** and zero samples exist in any train/validation/test split.

---

## 3. Fine-Tuning Strategy

- **Base Architecture**: CCT-XS v2 (Compact Convolutional Transformer Extra-Small)
- **Pretrained Checkpoint**: `training/pretrained/cct_xs_v2_global.keras`
- **Initial Learning Rate**: 5e-5
- **Optimizer**: AdamW (weight decay 0.01)
- **Learning Rate Schedule**: Cosine Decay with warmup
- **Loss Function**: Categorical Cross-Entropy with 0.01 label smoothing
- **Max Epochs**: 15
- **Early Stopping Patience**: 4 epochs monitoring `val_plate_acc`
- **Data Augmentations**:
  - Mild brightness / contrast adjustment ($\pm 15\%$)
  - Mild Gaussian / motion blur
  - Mild JPEG compression artifact simulation
  - Small rotation ($\pm 5^\circ$) and mild perspective jitter
  - Validation and test splits are strictly unaugmented

---

## 4. Production Artifacts

- Best checkpoint: `training/runs/<run_id>/best.keras`
- Exported ONNX model: `models/license-plate-ocr-india-finetuned.onnx`
- Preserves input tensor shape `[1, 64, 128, 3] uint8` and output shape `[1, 10, 37] float32`.
- Compatible with VisionTrack Node.js `neuralPlateOcr.js` inference runtime.
