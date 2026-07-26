"""Parquet round-trip gate for the v0.5.0 span columns (#519, rebuild-plan step 1).

The shard pipeline is JSONL (builders, via ``alignRow``) → converter →
parquet → this package's PyArrow readers. JSONL has carried the span triple since #527; this
test pins the two properties the parquet leg must now hold:

1. **Round-trip identity** — ``span_starts``/``span_ends``/``span_tags`` written by the real
   converter read back bit-identical through PyArrow (the reader stack the training
   loader uses), including the empty-triple (all-O) row.
2. **Loud refusal** — a row missing the triple, or carrying a partial one, fails the conversion
   with a named row. Silent loss (the pre-#519 behavior: columns simply dropped) is the hazard
   this step exists to close.

Runs the converter via subprocess so the gate covers the actual converter, not a
re-implementation. The converter was ported from ``scripts/jsonl-to-parquet.py`` to
TypeScript (e61a4a0d, the TypeScript-monoculture ship) and now lives at
``corpus/src/tools/jsonl-to-parquet.ts`` — a DuckDB rewrite verified field-for-field
against the PyArrow original. The subprocess therefore drives it through ``node`` (which
strips types natively) with the inline driver below. Requires the JS toolchain at the repo
root (``node`` on PATH + ``yarn install`` for the converter's deps); the tests skip with a
reason when either is absent.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pyarrow.parquet as pq
import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]
CONVERTER = REPO_ROOT / "corpus" / "src" / "tools" / "jsonl-to-parquet.ts"
NODE = shutil.which("node")

pytestmark = pytest.mark.skipif(
    NODE is None or not CONVERTER.is_file() or not (REPO_ROOT / "node_modules").is_dir(),
    reason="span converter is TypeScript now — needs node on PATH + `yarn install` at the repo root",
)

# Inline node driver: imports the real TS converter (Node strips types natively), runs it on
# the argv-supplied paths, and forwards any thrown error's message to stderr with a non-zero
# exit — so the loud-failure assertions below exercise the converter's own contract text.
_NODE_DRIVER = """
import { pathToFileURL } from "node:url";
const { jsonlToParquet } = await import(pathToFileURL(%s).href);
const [input, output] = process.argv.slice(1);
try {
    await jsonlToParquet({ input, output });
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
}
""" % json.dumps(str(CONVERTER))  # noqa: UP031 — %-format keeps the JS braces unescaped


def _row(**over) -> dict:
    base = {
        "raw": "1600 Pennsylvania Ave NW, Washington, DC 20500",
        "tokens": ["1600", "Pennsylvania", "Ave", "NW", "Washington", "DC", "20500"],
        "labels": ["B-house_number", "B-street", "I-street", "I-street", "B-locality", "B-region", "B-postcode"],
        "span_starts": [0, 5, 26, 38, 41],
        "span_ends": [4, 24, 36, 40, 46],
        "span_tags": ["house_number", "street", "locality", "region", "postcode"],
        "country": "US",
        "locale": "en-US",
        "source": "test",
        "source_id": "t-1",
        "corpus_version": "0.5.0",
        "license": "CC0-1.0",
        "synth_method": None,
        "synth_base_id": None,
    }
    base.update(over)
    return base


def _convert(tmp_path: Path, rows: list[dict]) -> subprocess.CompletedProcess:
    jsonl = tmp_path / "rows.jsonl"
    jsonl.write_text("".join(json.dumps(r) + "\n" for r in rows), encoding="utf-8")
    out = tmp_path / "rows.parquet"
    return subprocess.run(
        [NODE or "node", "--input-type=module", "-e", _NODE_DRIVER, str(jsonl), str(out)],
        capture_output=True,
        text=True,
        cwd=REPO_ROOT,
    )


def test_span_columns_round_trip(tmp_path: Path) -> None:
    rows = [
        _row(source_id="t-multi"),
        # Intra-span punctuation — offsets the token columns structurally cannot carry.
        _row(
            source_id="t-pobox",
            raw="P.O. Box 19",
            tokens=["P", "O", "Box", "19"],
            labels=["B-po_box", "I-po_box", "I-po_box", "I-po_box"],
            span_starts=[0],
            span_ends=[11],
            span_tags=["po_box"],
        ),
        # All-O row: a legitimately EMPTY triple must survive as [], not null.
        _row(
            source_id="t-all-o",
            raw="hello world",
            tokens=["hello", "world"],
            labels=["O", "O"],
            span_starts=[],
            span_ends=[],
            span_tags=[],
        ),
    ]
    result = _convert(tmp_path, rows)
    assert result.returncode == 0, result.stderr

    table = pq.read_table(tmp_path / "rows.parquet")
    for col in ("span_starts", "span_ends", "span_tags"):
        assert col in table.column_names
    by_id = {
        sid: (starts, ends, tags)
        for sid, starts, ends, tags in zip(
            table["source_id"].to_pylist(),
            table["span_starts"].to_pylist(),
            table["span_ends"].to_pylist(),
            table["span_tags"].to_pylist(),
            strict=True,
        )
    }
    assert by_id["t-multi"] == (
        [0, 5, 26, 38, 41],
        [4, 24, 36, 40, 46],
        ["house_number", "street", "locality", "region", "postcode"],
    )
    assert by_id["t-pobox"] == ([0], [11], ["po_box"])
    assert by_id["t-all-o"] == ([], [], [])


def test_missing_span_triple_fails_loudly(tmp_path: Path) -> None:
    row = _row(source_id="t-legacy")
    for col in ("span_starts", "span_ends", "span_tags"):
        del row[col]
    result = _convert(tmp_path, [_row(source_id="t-ok"), row])
    assert result.returncode != 0
    assert "missing the char-offset span triple" in result.stderr
    assert "line 2" in result.stderr
    assert not (tmp_path / "rows.parquet").exists()


@pytest.mark.parametrize("dropped", ["span_starts", "span_ends", "span_tags"])
def test_partial_span_triple_fails_loudly(tmp_path: Path, dropped: str) -> None:
    row = _row(source_id="t-partial")
    del row[dropped]
    result = _convert(tmp_path, [row])
    assert result.returncode != 0
    assert "missing the char-offset span triple" in result.stderr


def test_nonparallel_span_triple_fails_loudly(tmp_path: Path) -> None:
    result = _convert(tmp_path, [_row(source_id="t-skew", span_tags=["street"])])
    assert result.returncode != 0
    assert "not parallel" in result.stderr
