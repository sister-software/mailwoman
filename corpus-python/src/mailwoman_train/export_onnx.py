"""Export a trained checkpoint to ONNX with dynamic axes, verify PyTorch ↔ ONNX parity.

Per Phase 2 §7:

- Opset 17.
- Dynamic axes for ``batch`` and ``sequence``.
- Verify ONNX inference matches PyTorch inference within 1e-4 on a 1000-sample probe.
- Output: ``/data/models/onnx/model-v0.1.0-en-us.onnx`` (and per spec, the same weights are
  exported per-locale; Phase 3 may split them if size or load behavior demands).
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import torch
from torch import nn


def export_to_onnx(
    model: nn.Module,
    output_path: Path,
    *,
    opset: int = 17,
    max_length: int = 128,
    pad_token_id: int = 0,
) -> Path:
    """Export the token-classification model to ONNX. Returns the output path.

    Always exports from CPU. torch.onnx.export on a ROCm/HIP device on gfx1103 has been
    observed to hang during graph tracing (HW Exception, GPU node-1 hang) — exporting from
    CPU is fast (the model is small) and avoids the issue.
    """
    output_path.parent.mkdir(parents=True, exist_ok=True)
    model.eval()
    model_cpu = model.to("cpu")
    dummy_ids = torch.full((1, max_length), pad_token_id, dtype=torch.long)
    dummy_ids[0, 0] = 1  # ensure at least one non-pad slot
    dummy_mask = torch.ones((1, max_length), dtype=torch.long)

    # Postcode-anchor channel (#239/#240): when the model carries it, export the anchor inputs so the
    # inference runtime can FEED the anchor (without them the ONNX would be hard-wired anchor-free, the
    # c=0 identity — which is exactly the "anchor not fed" path, not the channel under test).
    has_anchor = bool(getattr(model_cpu, "use_postcode_anchor", False))
    anchor_dim = int(getattr(model_cpu, "anchor_feature_dim", 0))

    # ONNX exporter prefers plain-tensor outputs; wrap the model so forward returns just logits.
    class _LogitsOnly(nn.Module):
        def __init__(self, inner: nn.Module) -> None:
            super().__init__()
            self.inner = inner

        def forward(self, input_ids: torch.Tensor, attention_mask: torch.Tensor) -> torch.Tensor:
            return self.inner(input_ids=input_ids, attention_mask=attention_mask).logits

    class _LogitsOnlyAnchor(nn.Module):
        def __init__(self, inner: nn.Module) -> None:
            super().__init__()
            self.inner = inner

        def forward(
            self,
            input_ids: torch.Tensor,
            attention_mask: torch.Tensor,
            anchor_features: torch.Tensor,
            anchor_confidence: torch.Tensor,
        ) -> torch.Tensor:
            return self.inner(
                input_ids=input_ids,
                attention_mask=attention_mask,
                anchor_features=anchor_features,
                anchor_confidence=anchor_confidence,
            ).logits

    if has_anchor:
        export_model = _LogitsOnlyAnchor(model_cpu).eval()
        args = (
            dummy_ids,
            dummy_mask,
            torch.zeros((1, max_length, anchor_dim), dtype=torch.float32),
            torch.zeros((1, max_length), dtype=torch.float32),
        )
        input_names = ["input_ids", "attention_mask", "anchor_features", "anchor_confidence"]
        dynamic_shapes = {
            "input_ids": {0: "batch", 1: "sequence"},
            "attention_mask": {0: "batch", 1: "sequence"},
            "anchor_features": {0: "batch", 1: "sequence"},  # dim 2 (anchor_feature_dim) is fixed
            "anchor_confidence": {0: "batch", 1: "sequence"},
        }
    else:
        export_model = _LogitsOnly(model_cpu).eval()
        args = (dummy_ids, dummy_mask)
        input_names = ["input_ids", "attention_mask"]
        dynamic_shapes = {
            "input_ids": {0: "batch", 1: "sequence"},
            "attention_mask": {0: "batch", 1: "sequence"},
        }

    # Use the dynamo exporter (``dynamo=True``). The legacy TorchScript path hits
    # ``IndexError: tuple index out of range`` inside transformers ≥5's ``masking_utils``
    # (``sdpa_mask`` reads ``q_length.shape[0]`` on what the tracer sees as a tuple).
    # The dynamo path traces through correctly via FX.
    torch.onnx.export(
        export_model,
        args,
        str(output_path),
        input_names=input_names,
        output_names=["logits"],
        opset_version=opset,
        dynamic_shapes=dynamic_shapes,
        dynamo=True,
        external_data=False,
    )
    return output_path


def verify_parity(
    model: nn.Module,
    onnx_path: Path,
    sample_inputs: list[tuple[list[int], list[int]]],
    *,
    atol: float = 1e-4,
) -> dict:
    """Compare ONNX logits to PyTorch logits over a sample. Returns a metrics dict.

    Logs the max absolute diff across samples; raises if any exceeds ``atol``.
    """
    import onnxruntime as ort  # type: ignore[import-not-found]

    session = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
    model_cpu = model.to("cpu").eval()
    max_diff = 0.0
    n = 0
    with torch.no_grad():
        for ids, mask in sample_inputs:
            x = torch.tensor([ids], dtype=torch.long)
            m = torch.tensor([mask], dtype=torch.long)
            torch_logits = model_cpu(input_ids=x, attention_mask=m).logits.cpu().numpy()
            ort_logits = session.run(
                ["logits"],
                {
                    "input_ids": np.asarray([ids], dtype=np.int64),
                    "attention_mask": np.asarray([mask], dtype=np.int64),
                },
            )[0]
            diff = float(np.max(np.abs(torch_logits - ort_logits)))
            max_diff = max(max_diff, diff)
            n += 1
    if max_diff > atol:
        raise RuntimeError(
            f"ONNX/PyTorch parity broken: max_abs_diff={max_diff} > tolerance={atol}"
        )
    return {"samples": n, "max_abs_diff": max_diff, "tolerance": atol}
