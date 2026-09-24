"""
Feature 3B: Fine-Tune CCT-XS for Indian License Plate OCR
Conservative domain adaptation training script using official FastPlateOCR workflow.
"""

import os
import sys

# Ensure Keras uses PyTorch backend before any imports
os.environ["KERAS_BACKEND"] = "torch"

import json
import pathlib
import time
from datetime import datetime

from fast_plate_ocr.cli.train import train as fast_plate_train


def run_training(
    model_config_file: str = "training/config/cct_xs_v2_model_config.yaml",
    plate_config_file: str = "training/config/cct_xs_v2_plate_config.yaml",
    train_annotations: str = r"D:\Download\ANPR_OCR_TRAINING_DATASET\train_fastplate.csv",
    val_annotations: str = r"D:\Download\ANPR_OCR_TRAINING_DATASET\validation_fastplate.csv",
    weights_path: str = "training/pretrained/cct_xs_v2_global.keras",
    output_dir: str = "training/runs/india_finetune",
    lr: float = 5e-5,
    epochs: int = 15,
    early_stopping_patience: int = 4,
    batch_size: int = 64,
    seed: int = 42,
    workers: int = 2,
):
    print("=" * 60)
    print("Feature 3B — CCT-XS Fine-Tuning for Indian License Plates")
    print("=" * 60)
    print(f"Start Time:                {datetime.now().isoformat()}")
    print(f"Base Pretrained Weights:   {weights_path}")
    print(f"Model Architecture Config: {model_config_file}")
    print(f"Plate Specification:       {plate_config_file}")
    print(f"Train Dataset:             {train_annotations}")
    print(f"Validation Dataset:        {val_annotations}")
    print(f"Initial Learning Rate:     {lr}")
    print(f"Max Epochs:                {epochs}")
    print(f"Early Stopping Patience:   {early_stopping_patience} epochs")
    print(f"Batch Size:                {batch_size}")
    print(f"Random Seed:               {seed}")
    print(f"Output Directory:          {output_dir}")
    print("=" * 60)

    out_path = pathlib.Path(output_dir)
    out_path.mkdir(parents=True, exist_ok=True)

    args = [
        "--model-config-file", str(model_config_file),
        "--plate-config-file", str(plate_config_file),
        "--annotations", str(train_annotations),
        "--val-annotations", str(val_annotations),
        "--weights-path", str(weights_path),
        "--lr", str(lr),
        "--epochs", str(epochs),
        "--early-stopping-patience", str(early_stopping_patience),
        "--batch-size", str(batch_size),
        "--output-dir", str(output_dir),
        "--seed", str(seed),
        "--workers", str(workers),
        "--plate-loss", "cce",
        "--label-smoothing", "0.01",
        "--plate-loss-weight", "0.9",
        "--region-loss-weight", "0.1",
        "--use-ema",
    ]

    start_time = time.time()

    fast_plate_train.main(args=args, standalone_mode=False)

    elapsed_sec = time.time() - start_time
    print(f"\nTraining completed in {elapsed_sec:.2f} seconds ({elapsed_sec/60:.2f} minutes).")

    # Record run details
    meta = {
        "timestamp": datetime.now().isoformat(),
        "elapsed_seconds": elapsed_sec,
        "elapsed_minutes": elapsed_sec / 60,
        "weights_path": weights_path,
        "model_config_file": model_config_file,
        "plate_config_file": plate_config_file,
        "train_annotations": train_annotations,
        "val_annotations": val_annotations,
        "lr": lr,
        "epochs": epochs,
        "early_stopping_patience": early_stopping_patience,
        "batch_size": batch_size,
        "seed": seed,
        "output_dir": output_dir,
    }
    with open(out_path / "run_metadata.json", "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=2)


if __name__ == "__main__":
    run_training()
