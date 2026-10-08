"""Split the quantized token-embedding table out of an int8 ``model.onnx``.

The quantized graph reads its embedding table in two nodes: a ``Gather`` of ``input_ids`` over a
UINT8 ``[vocab, hidden]`` initializer, then one per-tensor ``DequantizeLinear``. The split removes
both nodes and the table, and declares a float ``inputs_embeds [batch, seq, hidden]`` input in
place of ``input_ids``. The runtime computes the same tensor as ``(row - zero_point) * scale``.

The table is written in the ``MWE1`` row-file layout, little-endian:

========  =====  =======================================================
offset    type   field
========  =====  =======================================================
0         4 B    magic ``MWE1``
4         u32    header bytes, always 32
8         u32    vocabulary size
12        u32    hidden width (bytes per row)
16        f32    dequantization scale
20        u32    dequantization zero point (0..255)
24        u32    row count in this file
28        u32    layout: 0 = every row in id order, 1 = a subset
========  =====  =======================================================

A full file (layout 0) holds ``vocab`` rows from offset 32, so row ``i`` sits at ``32 + i * hidden``
and an HTTP range read fetches it alone. A subset file (layout 1) holds ``row count`` u32 ids in
ascending order from offset 32, then the rows in the same order.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper

MAGIC = b"MWE1"
HEADER_BYTES = 32
LAYOUT_FULL = 0
LAYOUT_SUBSET = 1
INPUT_IDS = "input_ids"
INPUTS_EMBEDS = "inputs_embeds"


@dataclass(frozen=True)
class EmbeddingTable:
    """The quantized table and its per-tensor dequantization pair."""

    rows: np.ndarray
    scale: float
    zero_point: int

    @property
    def vocab_size(self) -> int:
        return int(self.rows.shape[0])

    @property
    def hidden(self) -> int:
        return int(self.rows.shape[1])


def _scalar(initializer: onnx.TensorProto, name: str) -> np.ndarray:
    value = numpy_helper.to_array(initializer)
    if value.size != 1:
        raise ValueError(f"{name} has shape {value.shape}; the split supports a per-tensor scale and zero point only")
    return value.reshape(())


def split_embeddings(model: onnx.ModelProto) -> EmbeddingTable:
    """Rewrite ``model`` in place into the encoder and return the table it no longer contains.

    Raises when ``input_ids`` feeds anything other than one ``Gather`` over a UINT8 initializer
    followed by one ``DequantizeLinear`` with scalar parameters.
    """
    graph = model.graph
    initializers = {i.name: i for i in graph.initializer}

    readers = [n for n in graph.node if INPUT_IDS in n.input]
    if len(readers) != 1 or readers[0].op_type != "Gather":
        raise ValueError(f"{INPUT_IDS} must feed exactly one Gather; read by {[n.op_type for n in readers]}")
    gather = readers[0]
    table_name = gather.input[0]
    if table_name not in initializers:
        raise ValueError(f"the Gather over {INPUT_IDS} reads {table_name}, which is not an initializer")
    table = numpy_helper.to_array(initializers[table_name])
    if table.dtype != np.uint8 or table.ndim != 2:
        raise ValueError(
            f"{table_name} is {table.dtype} {table.shape}; the split expects a UINT8 [vocab, hidden] table"
        )

    dequantizers = [n for n in graph.node if gather.output[0] in n.input]
    if len(dequantizers) != 1 or dequantizers[0].op_type != "DequantizeLinear":
        raise ValueError(
            f"the embedding Gather must feed exactly one DequantizeLinear; feeds {[n.op_type for n in dequantizers]}"
        )
    dequantize = dequantizers[0]
    scale = _scalar(initializers[dequantize.input[1]], dequantize.input[1])
    zero_point = (
        _scalar(initializers[dequantize.input[2]], dequantize.input[2]) if len(dequantize.input) > 2 else np.uint8(0)
    )

    embedded = dequantize.output[0]
    graph.node.remove(gather)
    graph.node.remove(dequantize)
    for node in graph.node:
        for k, name in enumerate(node.input):
            if name == embedded:
                node.input[k] = INPUTS_EMBEDS
    if any(o.name == embedded for o in graph.output):
        raise ValueError(f"{embedded} is a graph output; the split cannot remove it")

    still_read = {name for node in graph.node for name in node.input}
    for name in {table_name, *dequantize.input[1:]}:
        if name not in still_read and name in initializers:
            graph.initializer.remove(initializers[name])

    ids_input = next(i for i in graph.input if i.name == INPUT_IDS)
    dims = ids_input.type.tensor_type.shape.dim

    def dim(d: onnx.TensorShapeProto.Dimension) -> str | int:
        return d.dim_param if d.dim_param else d.dim_value

    embeds_input = helper.make_tensor_value_info(
        INPUTS_EMBEDS, TensorProto.FLOAT, [dim(dims[0]), dim(dims[1]), int(table.shape[1])]
    )
    position = list(graph.input).index(ids_input)
    graph.input.remove(ids_input)
    graph.input.insert(position, embeds_input)
    del graph.value_info[:]
    onnx.checker.check_model(model)

    return EmbeddingTable(rows=table, scale=float(scale), zero_point=int(zero_point))


def _header(table: EmbeddingTable, row_count: int, layout: int) -> bytes:
    header = MAGIC + struct.pack(
        "<IIIfIII", HEADER_BYTES, table.vocab_size, table.hidden, table.scale, table.zero_point, row_count, layout
    )
    if len(header) != HEADER_BYTES:
        raise ValueError(f"the MWE1 header packed to {len(header)} bytes")
    return header


def write_full_rows(table: EmbeddingTable, path: Path) -> Path:
    """Write every row in id order (layout 0)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(_header(table, table.vocab_size, LAYOUT_FULL) + np.ascontiguousarray(table.rows).tobytes())
    return path


def write_subset_rows(table: EmbeddingTable, ids: np.ndarray, path: Path) -> Path:
    """Write the rows of ``ids`` (layout 1), sorted ascending and deduplicated."""
    ordered = np.unique(ids.astype(np.int64))
    if ordered.size and (ordered[0] < 0 or ordered[-1] >= table.vocab_size):
        raise ValueError(f"subset ids must lie in [0, {table.vocab_size})")
    body = ordered.astype("<u4").tobytes() + np.ascontiguousarray(table.rows[ordered]).tobytes()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(_header(table, int(ordered.size), LAYOUT_SUBSET) + body)
    return path


def hot_ids(counts: np.ndarray, coverage: float, always: np.ndarray) -> np.ndarray:
    """Return the fewest ids whose counts reach ``coverage`` of all occurrences, plus ``always``."""
    if not 0 < coverage <= 1:
        raise ValueError("coverage must lie in (0, 1]")
    total = int(counts.sum())
    if total <= 0:
        raise ValueError("the piece counts sum to zero")
    order = np.argsort(-counts, kind="stable")
    cumulative = np.cumsum(counts[order]) / total
    take = int(np.searchsorted(cumulative, coverage - 1e-12) + 1)
    return np.unique(np.concatenate([order[:take], always.astype(np.int64)]))


def split_model_file(
    model_path: Path,
    out_dir: Path,
    *,
    counts: np.ndarray | None = None,
    coverage: float = 0.99,
    always: np.ndarray | None = None,
) -> dict[str, object]:
    """Write ``encoder.onnx``, ``embeddings.rows`` and, given ``counts``, ``embeddings-hot.bin``.

    The full file is read by HTTP range, so its extension keeps it out of the publisher's whole-fetch
    gzip encoding. The hot subset is fetched whole and keeps ``.bin``.
    """
    model = onnx.load(str(model_path))
    table = split_embeddings(model)
    out_dir.mkdir(parents=True, exist_ok=True)
    encoder = out_dir / "encoder.onnx"
    onnx.save(model, str(encoder))
    full = write_full_rows(table, out_dir / "embeddings.rows")
    summary: dict[str, object] = {
        "encoder": str(encoder),
        "encoder_bytes": encoder.stat().st_size,
        "embeddings": str(full),
        "embeddings_bytes": full.stat().st_size,
        "vocab_size": table.vocab_size,
        "hidden": table.hidden,
        "scale": table.scale,
        "zero_point": table.zero_point,
    }
    if counts is not None:
        if counts.shape != (table.vocab_size,):
            raise ValueError(f"counts has shape {counts.shape}; the table has {table.vocab_size} rows")
        ids = hot_ids(counts, coverage, always if always is not None else np.zeros(0, np.int64))
        hot = write_subset_rows(table, ids, out_dir / "embeddings-hot.bin")
        summary.update(
            {"hot": str(hot), "hot_bytes": hot.stat().st_size, "hot_rows": int(ids.size), "coverage": coverage}
        )
    return summary
