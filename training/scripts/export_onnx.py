"""
Feature 3B: Export fine-tuned Keras checkpoint to ONNX format.
Validates numerical parity between native Keras and ONNX runtime outputs.
"""

import os
import sys

os.environ["KERAS_BACKEND"] = "torch"

import glob
import pathlib
import shutil
import keras
import numpy as np
import onnx
import onnxslim
import onnxruntime as ort
import torch
from fast_plate_ocr.train.model.config import load_plate_config_from_yaml
from fast_plate_ocr.train.model.layers import PatchExtractor
from fast_plate_ocr.train.utilities.utils import load_keras_model
from fast_plate_ocr.cli.export import _prepare_model_for_onnx_export, _validate_prediction


# Patch PatchExtractor.call for ONNX-export compatibility
# Replaces conv2d(eye) with exact equivalent reshape + permute to avoid unknown-kernel TorchScript ONNX export error
def _onnx_compatible_patch_extractor_call(self, images):
    batch_size, height, width, channels = keras.ops.shape(images)
    p = self.patch_size
    num_patches_h = height // p
    num_patches_w = width // p

    # images: (B, H, W, C) -> (B, H//p, p, W//p, p, C) -> permute(0, 1, 3, 2, 4, 5) -> reshape(B, num_patches, p*p*C)
    x = keras.ops.reshape(images, (batch_size, num_patches_h, p, num_patches_w, p, channels))
    x = keras.ops.transpose(x, (0, 1, 3, 2, 4, 5))
    patches = keras.ops.reshape(x, (batch_size, num_patches_h * num_patches_w, p * p * channels))
    return patches


PatchExtractor.call = _onnx_compatible_patch_extractor_call


def export_best_model(
    runs_dir: str = "training/runs/india_finetune",
    plate_config_file: str = "training/config/cct_xs_v2_plate_config.yaml",
    target_onnx_path: str = "models/license-plate-ocr-india-finetuned.onnx",
):
    print("=" * 60)
    print("Exporting Fine-Tuned CCT-XS Model to ONNX")
    print("=" * 60)

    keras_models = glob.glob(os.path.join(runs_dir, "**", "*.keras"), recursive=True)
    if not keras_models:
        raise FileNotFoundError(f"No .keras models found in {runs_dir}")

    best_model_path = None
    for m in keras_models:
        if "best" in os.path.basename(m).lower():
            best_model_path = m
            break
    if not best_model_path:
        best_model_path = keras_models[-1]

    print(f"Selected Keras Checkpoint: {best_model_path}")
    print(f"Plate Config:              {plate_config_file}")
    print(f"Target ONNX Path:          {target_onnx_path}")

    plate_config = load_plate_config_from_yaml(pathlib.Path(plate_config_file))
    model = load_keras_model(pathlib.Path(best_model_path), plate_config=plate_config)

    target_path = pathlib.Path(target_onnx_path)
    target_path.parent.mkdir(parents=True, exist_ok=True)

    export_model, spec_shape, dummy_input = _prepare_model_for_onnx_export(
        model,
        plate_config,
        dynamic_batch=True,
        input_dtype="uint8",
        data_format="channels_last",
    )
    spec = [keras.InputSpec(name="input", shape=spec_shape, dtype="uint8")]

    # Direct export avoiding Windows NamedTemporaryFile lock
    unslimmed_path = target_path.with_suffix(".unslimmed.onnx")
    print(f"Exporting to intermediate ONNX: {unslimmed_path}...")
    export_model.export(
        str(unslimmed_path),
        format="onnx",
        verbose=False,
        input_signature=spec,
    )

    print("Simplifying ONNX with onnxslim...")
    model_simp = onnxslim.slim(onnx.load(str(unslimmed_path)))

    # Ensure output tensor names match production expectations ('plate' and 'region')
    if len(model_simp.graph.output) >= 2:
        old_plate = model_simp.graph.output[0].name
        old_region = model_simp.graph.output[1].name
        for node in model_simp.graph.node:
            for i, out in enumerate(node.output):
                if out == old_plate:
                    node.output[i] = "plate"
                elif out == old_region:
                    node.output[i] = "region"
        model_simp.graph.output[0].name = "plate"
        model_simp.graph.output[1].name = "region"

    onnx.save(model_simp, str(target_path))

    if unslimmed_path.exists():
        unslimmed_path.unlink()

    print(f"\nSuccessfully saved ONNX model to {target_onnx_path}")

    # Inspect ONNX model
    sess = ort.InferenceSession(str(target_path))
    inputs = sess.get_inputs()
    outputs = sess.get_outputs()
    print("\nONNX Model Inputs:")
    for inp in inputs:
        print(f"  - name: {inp.name}, shape: {inp.shape}, type: {inp.type}")
    print("\nONNX Model Outputs:")
    for out in outputs:
        print(f"  - name: {out.name}, shape: {out.shape}, type: {out.type}")

    # Validate predictions parity between Keras and ONNX
    onnx_output_names = [o.name for o in sess.get_outputs()]
    input_name = sess.get_inputs()[0].name
    keras_keys = list(export_model.output.keys())

    def _predict(x: np.ndarray):
        values = sess.run(onnx_output_names, {input_name: x})
        return dict(zip(keras_keys, values, strict=False))

    _validate_prediction(
        export_model,
        _predict,
        dummy_input,
        "ONNX",
        output_names=keras_keys,
    )
    print("\nNumerical parity between Keras and ONNX model verified successfully!")


if __name__ == "__main__":
    export_best_model()
