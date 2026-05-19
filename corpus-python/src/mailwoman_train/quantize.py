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
"""

from __future__ import annotations

from pathlib import Path

from onnxruntime.quantization import QuantType, quantize_dynamic  # type: ignore[import-not-found]


def quantize_dynamic_int8(
    fp32_path: Path,
    int8_path: Path,
    *,
    weight_type: QuantType = QuantType.QInt8,
) -> Path:
    """Dynamically quantize an ONNX model to int8 weights."""
    int8_path.parent.mkdir(parents=True, exist_ok=True)
    quantize_dynamic(
        model_input=str(fp32_path),
        model_output=str(int8_path),
        weight_type=weight_type,
        # MatMul is the dominant op family; default optype filter covers it.
    )
    return int8_path
