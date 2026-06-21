"""Int8 dynamic quantization via onnxruntime.quantization.

Per Phase 2 §8:

- Int8 dynamic quantization.
- Calibrate on 1000 val-set examples (dynamic quantization doesn't strictly *need* a
  calibration set, but we run an end-to-end smoke over the val set to catch shape /
  op-support regressions before they hit the eval gate).
- Verify quantized model F1 drops by less than 0.5% from fp32 on the golden set.

Dynamic vs static: dynamic quantizes weights at conversion time but activations at runtime.
It avoids needing a calibration data feeder built into the ORT toolchain and is the spec'd
mode for §8. If we ever need static (per-channel + activation quant), revisit here.

Stale-value_info guard (2026-06-09): ``quantize_dynamic`` runs onnx shape inference internally
(``save_and_reload_model_with_shape_infer``). The dynamo ONNX exporter writes intermediate
``value_info`` shape annotations into the graph, and a toolchain drift (``transformers`` /
``onnxscript`` / ``torch.onnx`` float — our deps were unpinned ``>=``) started emitting a
``locale_film`` annotation (``[768] = 2*hidden``) that newer onnx (≥1.21) infers as ``384`` and
then REJECTS with ``[ShapeInferenceError] ... (384) vs (768)``. The annotations are redundant
(onnx re-infers them), so we strip ``graph.value_info`` before quantizing — onnx then infers
clean shapes and quantization succeeds. This is why the Jun-6 v0.9.3 int8 built fine on the
older toolchain but a Jun-8 re-export of the SAME checkpoint did not (drift, not a model change).
Pinning the export/quant deps is the deeper fix; this strip makes quantization resilient to the drift.
"""

from __future__ import annotations

from pathlib import Path

import onnx
from onnxruntime.quantization import QuantType, quantize_dynamic  # type: ignore[import-not-found]


def _strip_value_info(src: Path, dst: Path) -> Path:
    """Drop intermediate ``value_info`` so onnx re-infers shapes cleanly at quantize time.

    Graph inputs, outputs, and initializers are untouched; only the (redundant, possibly
    stale) intermediate shape annotations are cleared. See module docstring for why.
    """
    model = onnx.load(str(src))
    del model.graph.value_info[:]
    dst.parent.mkdir(parents=True, exist_ok=True)
    onnx.save(model, str(dst))
    return dst


def quantize_dynamic_int8(
    fp32_path: Path,
    int8_path: Path,
    *,
    weight_type: QuantType = QuantType.QInt8,
) -> Path:
    """Dynamically quantize an ONNX model to int8 weights."""
    int8_path.parent.mkdir(parents=True, exist_ok=True)
    # Strip stale value_info first (see module docstring) so onnx shape inference inside
    # quantize_dynamic doesn't reject the dynamo-exported graph.
    cleaned = _strip_value_info(fp32_path, int8_path.with_suffix(".stripped.onnx"))
    quantize_dynamic(
        model_input=str(cleaned),
        model_output=str(int8_path),
        weight_type=weight_type,
        # MatMul is the dominant op family; default optype filter covers it.
    )
    cleaned.unlink(missing_ok=True)
    return int8_path
