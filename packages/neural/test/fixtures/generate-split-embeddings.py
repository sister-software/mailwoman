"""Generate the split-embedding fixture the TS runners' equivalence tests read.

Builds a small int8-shaped graph with the same embedding read as a quantized release (a ``Gather`` of
``input_ids`` over a UINT8 table, then one per-tensor ``DequantizeLinear``), and splits it through
corpus-python's real exporter (``mailwoman_train.export.split_embeddings``). The output directory
holds the unsplit ``model.onnx``, the split ``encoder.onnx``, the full ``embeddings.rows`` and an
``embeddings-hot.bin`` subset that omits most ids, so the tests exercise range reads.

Run from the repository root:
    uv run --extra train python packages/neural/test/fixtures/generate-split-embeddings.py
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper

from mailwoman_train.export.split_embeddings import split_model_file

VOCAB = 64
HIDDEN = 8
LABELS = 5
OUT = Path(__file__).parent / "split-embeddings"


def main() -> None:
    rng = np.random.default_rng(2505)
    table = rng.integers(0, 256, size=(VOCAB, HIDDEN), dtype=np.uint8)
    weight = rng.standard_normal((HIDDEN, LABELS)).astype(np.float32)
    graph = helper.make_graph(
        [
            helper.make_node("Gather", ["table_q", "input_ids"], ["gathered"]),
            helper.make_node("DequantizeLinear", ["gathered", "scale", "zero_point"], ["embedding"]),
            helper.make_node("MatMul", ["embedding", "weight"], ["logits"]),
        ],
        "split-embeddings-fixture",
        [
            helper.make_tensor_value_info("input_ids", TensorProto.INT64, ["batch", "seq"]),
            helper.make_tensor_value_info("attention_mask", TensorProto.INT64, ["batch", "seq"]),
        ],
        [helper.make_tensor_value_info("logits", TensorProto.FLOAT, ["batch", "seq", LABELS])],
        [
            numpy_helper.from_array(table, "table_q"),
            numpy_helper.from_array(np.array(0.0123, np.float32), "scale"),
            numpy_helper.from_array(np.array(131, np.uint8), "zero_point"),
            numpy_helper.from_array(weight, "weight"),
        ],
    )
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 17)])
    model.ir_version = 8
    OUT.mkdir(parents=True, exist_ok=True)
    onnx.save(model, str(OUT / "model.onnx"))

    counts = np.zeros(VOCAB, np.int64)
    counts[[5, 6, 7, 8]] = [40, 30, 20, 10]
    split_model_file(OUT / "model.onnx", OUT, counts=counts, coverage=1.0, always=np.array([0, 1, 2, 3]))


if __name__ == "__main__":
    main()
