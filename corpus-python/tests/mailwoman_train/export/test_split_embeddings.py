"""The embedding split reproduces the unsplit graph's outputs from the MWE1 row files."""

from __future__ import annotations

import struct
from pathlib import Path

import numpy as np
import onnx
import onnxruntime as ort
import pytest
from onnx import TensorProto, helper, numpy_helper

from mailwoman_train.export.split_embeddings import (
    HEADER_BYTES,
    hot_ids,
    split_model_file,
)

VOCAB = 11
HIDDEN = 4
LABELS = 3


def _fixture(path: Path) -> Path:
    rng = np.random.default_rng(7)
    table = rng.integers(0, 256, size=(VOCAB, HIDDEN), dtype=np.uint8)
    weight = rng.standard_normal((HIDDEN, LABELS)).astype(np.float32)
    graph = helper.make_graph(
        [
            helper.make_node("Gather", ["table_q", "input_ids"], ["gathered"], name="node_embedding"),
            helper.make_node("DequantizeLinear", ["gathered", "scale", "zero_point"], ["embedding"]),
            helper.make_node("MatMul", ["embedding", "weight"], ["logits"]),
        ],
        "fixture",
        [helper.make_tensor_value_info("input_ids", TensorProto.INT64, ["batch", "seq"])],
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
    onnx.save(model, str(path))
    return path


def _rows(path: Path) -> tuple[dict[int, np.ndarray], float, int]:
    data = path.read_bytes()
    assert data[:4] == b"MWE1"
    header, vocab, hidden, scale, zero_point, count, layout = struct.unpack("<IIIfIII", data[4:HEADER_BYTES])
    assert header == HEADER_BYTES and vocab == VOCAB and hidden == HIDDEN
    if layout == 0:
        ids = np.arange(count)
        body = HEADER_BYTES
    else:
        ids = np.frombuffer(data, "<u4", count, HEADER_BYTES)
        body = HEADER_BYTES + 4 * count
    rows = np.frombuffer(data, np.uint8, count * hidden, body).reshape(count, hidden)
    return {int(i): rows[k] for k, i in enumerate(ids)}, scale, zero_point


def test_split_matches_unsplit_outputs(tmp_path: Path) -> None:
    model = _fixture(tmp_path / "model.onnx")
    counts = np.array([0, 0, 0, 0, 50, 30, 10, 5, 3, 1, 1])
    summary = split_model_file(model, tmp_path / "out", counts=counts, coverage=0.9, always=np.array([0]))

    full, scale, zero_point = _rows(tmp_path / "out" / "embeddings.rows")
    hot, _, _ = _rows(tmp_path / "out" / "embeddings-hot.bin")
    assert sorted(hot) == [0, 4, 5, 6]
    assert summary["hot_rows"] == 4
    for i, row in hot.items():
        np.testing.assert_array_equal(row, full[i])

    options = ort.SessionOptions()
    options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_DISABLE_ALL
    unsplit = ort.InferenceSession(str(model), options)
    encoder = ort.InferenceSession(str(tmp_path / "out" / "encoder.onnx"), options)
    assert [i.name for i in encoder.get_inputs()] == ["inputs_embeds"]

    ids = np.array([[4, 9, 0, 10, 5]], np.int64)
    embeds = np.stack(
        [((full[int(i)].astype(np.int32) - zero_point) * np.float32(scale)).astype(np.float32) for i in ids[0]]
    )[None]
    (expected,) = unsplit.run(None, {"input_ids": ids})
    (actual,) = encoder.run(None, {"inputs_embeds": embeds})
    np.testing.assert_array_equal(actual, expected)


def test_split_refuses_a_per_axis_scale(tmp_path: Path) -> None:
    path = _fixture(tmp_path / "model.onnx")
    model = onnx.load(str(path))
    scale = next(i for i in model.graph.initializer if i.name == "scale")
    scale.CopyFrom(numpy_helper.from_array(np.full(HIDDEN, 0.01, np.float32), "scale"))
    onnx.save(model, str(path))
    with pytest.raises(ValueError, match="per-tensor"):
        split_model_file(path, tmp_path / "out")


def test_hot_ids_takes_the_fewest_rows_reaching_coverage() -> None:
    counts = np.array([5, 0, 3, 2])
    assert hot_ids(counts, 0.5, np.array([1])).tolist() == [0, 1]
    assert hot_ids(counts, 1.0, np.zeros(0, np.int64)).tolist() == [0, 2, 3]
