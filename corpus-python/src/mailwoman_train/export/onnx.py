"""Export a trained checkpoint to ONNX with dynamic axes, verify PyTorch ↔ ONNX parity.

Per Phase 2 §7:

- Opset 17.
- Dynamic axes for ``batch`` and ``sequence``.
- Verify ONNX inference matches PyTorch inference within 1e-4 on a 1000-sample probe.
- Output: ``/data/models/onnx/model-v0.1.0-en-us.onnx`` (and per spec, the same weights are
  exported per-locale; Phase 3 may split them if size or load behavior demands).

`graph.py` decides WHAT gets exported — which channels the model carries, whether that combination
is exportable, and the wrapper and example inputs it needs. This module runs the export and checks
the result against PyTorch.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import numpy as np
import torch
from torch import nn

from .graph import build_export_graph, detect_channels


def export_to_onnx(
    model: nn.Module,
    output_path: Path,
    *,
    opset: int = 17,
    max_length: int = 128,
    pad_token_id: int = 0,
    dummy_batch: int = 1,
    char_window: int | None = None,
) -> Path:
    """Export the token-classification model to ONNX. Returns the output path.

    A char-path model (``use_char_embed``) exports behind ``char_ids (batch, sequence, char_window)`` +
    ``attention_mask (batch, sequence)`` and no ``input_ids``: its forward never reads token ids, and a
    graph that took them would bind the runtime to a SentencePiece vocabulary the model does not have.
    ``char_window`` is the training config's ``max_unit_width`` (the unit plus its context characters), a
    data-side constant the model does not carry, so the caller must pass it; ``max_length`` is
    ``max_units``. The char path is channel-free by contract (D5), so none of the anchor, gazetteer or
    lexicon inputs are exported for it.

    Always exports from CPU. torch.onnx.export on a ROCm/HIP device on gfx1103 has been
    observed to hang during graph tracing (HW Exception, GPU node-1 hang) — exporting from
    CPU is fast (the model is small) and avoids the issue.

    ``dummy_batch`` is the batch size of the example inputs the exporter traces. It stays 1 (the
    shipped graph) unless a caller is probing batched inference: every input already REQUESTS a
    dynamic dim-0 via ``dynamic_shapes``, but the shipped graph still refuses batch > 1 at runtime,
    so the request is not being honored. Tracing with batch > 1 is the probe for whether the
    example's batch size is what pins the graph.
    """
    output_path.parent.mkdir(parents=True, exist_ok=True)
    model.eval()
    model_cpu = model.to("cpu")
    graph = build_export_graph(
        model_cpu,
        detect_channels(model_cpu),
        batch=dummy_batch,
        max_length=max_length,
        pad_token_id=pad_token_id,
        char_window=char_window,
    )

    # Use the dynamo exporter (``dynamo=True``). The legacy TorchScript path hits
    # ``IndexError: tuple index out of range`` inside transformers ≥5's ``masking_utils``
    # (``sdpa_mask`` reads ``q_length.shape[0]`` on what the tracer sees as a tuple).
    # The dynamo path traces through correctly via FX.
    torch.onnx.export(
        graph.module,
        graph.args,
        str(output_path),
        input_names=graph.input_names,
        output_names=graph.output_names,
        opset_version=opset,
        dynamic_shapes=graph.dynamic_shapes,
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
) -> dict[str, Any]:
    """Compare ONNX logits to PyTorch logits over a sample. Returns a metrics dict.

    Logs the max absolute diff across samples; raises if any exceeds ``atol``.
    """
    import onnxruntime as ort

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
        raise RuntimeError(f"ONNX/PyTorch parity broken: max_abs_diff={max_diff} > tolerance={atol}")
    return {"samples": n, "max_abs_diff": max_diff, "tolerance": atol}


def verify_char_parity(
    model: nn.Module,
    onnx_path: Path,
    sample_inputs: list[tuple[list[list[int]], list[int]]],
    *,
    atol: float = 1e-4,
) -> dict[str, Any]:
    """The char-path twin of :func:`verify_parity`: each sample is ``(char_ids (S, W), attention_mask (S))``."""
    import onnxruntime as ort

    session = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
    model_cpu = model.to("cpu").eval()
    max_diff = 0.0
    n = 0
    with torch.no_grad():
        for chars, mask in sample_inputs:
            x = torch.tensor([chars], dtype=torch.long)
            m = torch.tensor([mask], dtype=torch.long)
            torch_logits = model_cpu(char_ids=x, attention_mask=m).logits.cpu().numpy()
            ort_logits = session.run(
                ["logits"],
                {
                    "char_ids": np.asarray([chars], dtype=np.int64),
                    "attention_mask": np.asarray([mask], dtype=np.int64),
                },
            )[0]
            diff = float(np.max(np.abs(torch_logits - ort_logits)))
            max_diff = max(max_diff, diff)
            n += 1
    if max_diff > atol:
        raise RuntimeError(f"ONNX/PyTorch char parity broken: max_abs_diff={max_diff} > tolerance={atol}")
    return {"samples": n, "max_abs_diff": max_diff, "tolerance": atol}
