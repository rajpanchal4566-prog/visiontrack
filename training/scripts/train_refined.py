"""
Feature 3B (Refined): Fine-Tune CCT-XS for Indian License Plate OCR
Continued fine-tuning from best.keras checkpoint to resolve trailing duplicate characters
and improve general real-world plate accuracy.
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


def run_refined_training(
    model_config_file: str = "training/config/cct_xs_v2_model_config.yaml",
    plate_config_file: str = "training/config/cct_xs_v2_plate_config.yaml",
    train_annotations: str = r"D:\Download\ANPR_OCR_TRAINING_DATASET\train_fastplate.csv",
    val_annotations: str = r"D:\Download\ANPR_OCR_TRAINING_DATASET\validation_fastplate.csv",
    weights_path: str = "training/runs/india_finetune/2026-09-19_20-19-50/best.keras",
    output_dir: str = "training/runs/india_finetune_v2",
    lr: float = 2e-5,
    epochs: int = 2,
    early_stopping_patience: int = 2,
    batch_size: int = 64,
    seed: int = 42,
    workers: int = 2,
):
    print("=" * 60)
    print("Feature 3B (Refined) — CCT-XS Continued Fine-Tuning")
    print("=" * 60)
    print(f"Start Time:                {datetime.now().isoformat()}")
    print(f"Starting Checkpoint:       {weights_path}")
    print(f"Model Architecture Config: {model_config_file}")
    print(f"Plate Specification:       {plate_config_file}")
    print(f"Train Dataset:             {train_annotations}")
    print(f"Validation Dataset:        {val_annotations}")
    print(f"Learning Rate:             {lr}")
    print(f"Epochs:                    {epochs}")
    print(f"Batch Size:                {batch_size}")
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
        "--label-smoothing", "0.02",
        "--plate-loss-weight", "0.9",
        "--region-loss-weight", "0.1",
        "--use-ema",
    ]

    start_time = time.time()

    fast_plate_train.main(args=args, standalone_mode=False)

    elapsed_sec = time.time() - start_time
    print(f"\nTraining completed in {elapsed_sec:.2f} seconds ({elapsed_sec/60:.2f} minutes).")

    meta = {
        "timestamp": datetime.now().isoformat(),
        "elapsed_seconds": elapsed_sec,
        "elapsed_minutes": elapsed_sec / 60,
        "weights_path": weights_path,
        "lr": lr,
        "epochs": epochs,
        "batch_size": batch_size,
        "seed": seed,
        "output_dir": output_dir,
    }
    with open(out_path / "run_metadata.json", "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=2)


if __name__ == "__main__":
    run_refined_training()
