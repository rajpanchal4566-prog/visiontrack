"""
Feature 3B: Evaluate fine-tuned CCT-XS model on validation and test splits.
Reports exact accuracy, normalized accuracy, CER, and character accuracy.
"""

import os
import sys

os.environ["KERAS_BACKEND"] = "torch"

import csv
import json
import pathlib
import time
import numpy as np
import onnxruntime as ort
from PIL import Image

ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_"
PAD_CHAR = "_"
MAX_SLOTS = 10


def levenshtein_distance(s1: str, s2: str) -> int:
    if len(s1) < len(s2):
        return levenshtein_distance(s2, s1)
    if len(s2) == 0:
        return len(s1)
    previous_row = range(len(s2) + 1)
    for i, c1 in enumerate(s1):
        current_row = [i + 1]
        for j, c2 in enumerate(s2):
            insertions = previous_row[j + 1] + 1
            deletions = current_row[j] + 1
            substitutions = previous_row[j] + (c1 != c2)
            current_row.append(min(insertions, deletions, substitutions))
        previous_row = current_row
    return previous_row[-1]


def decode_plate(logits: np.ndarray) -> str:
    """Decode [10, 37] logits into text."""
    pred_text = ""
    for slot in range(MAX_SLOTS):
        max_idx = int(np.argmax(logits[slot]))
        char = ALPHABET[max_idx]
        if char != PAD_CHAR:
            pred_text += char
    return pred_text


def evaluate_csv(
    session: ort.InferenceSession,
    csv_path: str,
    images_dir: str,
    split_name: str,
) -> dict:
    print(f"\nEvaluating split: {split_name} ({csv_path})...")
    with open(csv_path, "r", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))

    input_name = session.get_inputs()[0].name
    total = len(rows)
    exact_matches = 0
    total_dist = 0
    total_gt_len = 0
    total_char_correct = 0
    total_char_count = 0
    latencies = []

    # Confusion counters
    confusion_pairs = {
        "O_to_0": 0, "0_to_O": 0,
        "B_to_8": 0, "8_to_B": 0,
        "S_to_5": 0, "5_to_S": 0,
        "G_to_6": 0, "6_to_G": 0,
        "I_to_1": 0, "1_to_I": 0,
        "Z_to_2": 0, "2_to_Z": 0,
    }

    for row in rows:
        img_name = row.get("image")
        gt_text = row.get("text", "").strip().upper()
        img_path = os.path.join(images_dir, img_name)

        if not os.path.exists(img_path):
            continue

        # Load and resize image to 128x64 RGB uint8
        img = Image.open(img_path).convert("RGB").resize((128, 64), Image.Resampling.BILINEAR)
        img_arr = np.expand_dims(np.array(img, dtype=np.uint8), axis=0)

        t0 = time.perf_counter()
        outputs = session.run(None, {input_name: img_arr})
        t1 = time.perf_counter()
        latencies.append((t1 - t0) * 1000.0)

        logits = outputs[0][0]  # shape [10, 37]
        pred_text = decode_plate(logits)

        if pred_text == gt_text:
            exact_matches += 1

        dist = levenshtein_distance(pred_text, gt_text)
        total_dist += dist
        total_gt_len += len(gt_text)

        # Character accuracy
        min_len = min(len(pred_text), len(gt_text))
        for i in range(min_len):
            if pred_text[i] == gt_text[i]:
                total_char_correct += 1
            else:
                pair_key = f"{gt_text[i]}_to_{pred_text[i]}"
                if pair_key in confusion_pairs:
                    confusion_pairs[pair_key] += 1
        total_char_count += max(len(pred_text), len(gt_text))

    exact_acc = (exact_matches / total) * 100.0 if total > 0 else 0.0
    cer = (total_dist / total_gt_len) * 100.0 if total_gt_len > 0 else 0.0
    char_acc = (total_char_correct / total_char_count) * 100.0 if total_char_count > 0 else 0.0
    avg_latency = float(np.mean(latencies))
    p95_latency = float(np.percentile(latencies, 95))

    results = {
        "split": split_name,
        "total_samples": total,
        "exact_matches": exact_matches,
        "exact_accuracy_percent": round(exact_acc, 2),
        "cer_percent": round(cer, 2),
        "char_accuracy_percent": round(char_acc, 2),
        "avg_latency_ms": round(avg_latency, 2),
        "p95_latency_ms": round(p95_latency, 2),
        "confusion_samples": confusion_pairs,
    }

    print(f"Results for {split_name}:")
    print(f"  Exact Accuracy:  {exact_acc:.2f}% ({exact_matches}/{total})")
    print(f"  CER:             {cer:.2f}%")
    print(f"  Char Accuracy:   {char_acc:.2f}%")
    print(f"  Avg Latency:     {avg_latency:.2f} ms (P95: {p95_latency:.2f} ms)")

    return results


def main(
    onnx_path: str = "models/license-plate-ocr-india-finetuned.onnx",
    data_dir: str = r"D:\Download\ANPR_OCR_TRAINING_DATASET",
    out_json: str = "training/runs/india_finetune/split_eval_metrics.json",
):
    print("=" * 60)
    print("Evaluating Fine-Tuned Model on Synthetic Splits")
    print(f"Model: {onnx_path}")
    print("=" * 60)

    sess = ort.InferenceSession(onnx_path)
    images_dir = os.path.join(data_dir, "images")

    val_metrics = evaluate_csv(
        sess,
        os.path.join(data_dir, "validation.csv"),
        images_dir,
        "validation",
    )

    test_metrics = evaluate_csv(
        sess,
        os.path.join(data_dir, "test.csv"),
        images_dir,
        "test",
    )

    out_data = {
        "model": onnx_path,
        "validation": val_metrics,
        "test": test_metrics,
    }

    os.makedirs(os.path.dirname(out_json), exist_ok=True)
    with open(out_json, "w", encoding="utf-8") as f:
        json.dump(out_data, f, indent=2)
    print(f"\nSaved evaluation results to {out_json}")


if __name__ == "__main__":
    main()
