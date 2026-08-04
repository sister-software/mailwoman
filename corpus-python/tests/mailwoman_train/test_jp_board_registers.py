"""Per-register acceptability on the JP board — and proof the pre-registered gate is untouched.

The full JP shard (#1458) writes a ``register`` column on every board row (``native`` /
``arabic_chome`` / ``compact_folded`` / ``designator``). Two of those four surfaces appear in ZERO
source rows and exist only because ``build_jp_shard`` synthesizes them, and they are a small
minority of the board — so a blended average is exactly the statistic that would hide them failing.
``score_jp_probe_board.score_board`` splits the same per-row outcomes by that column.

What these tests pin, in order of how badly a regression would hurt:

1. The GATE. ``fraction`` is ``acceptable / rows`` over the whole board, an unresolved pair counts
   as unacceptable, and the bar is 0.70 — the 2026-07-18 pre-registration, unchanged. The
   per-register split is diagnostic and must not be able to move it: the board in
   ``test_gate_is_the_blended_number_even_when_a_register_is_wiped_out`` has one register at 0.0000
   and still reads PASS, because the blend clears 0.70.
2. The split is a partition of those same outcomes — per-register rows/acceptable/unresolved sum
   back to the blended totals. A bucketing bug that double-counted or dropped rows would otherwise
   be invisible in a report that prints both.
3. Boards with no ``register`` column (the Leg-1 probe board) still score identically, with no
   breakdown. This is the backward-compatibility guarantee that lets one script read both boards.

``score_board`` takes an injected ``predict``, so all of this runs on a synthetic board with no
checkpoint and no torch.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

from mailwoman_train.labels import resolve_label_set

_SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "score_jp_probe_board.py"


def _load_scorer():
    spec = importlib.util.spec_from_file_location("score_jp_probe_board", _SCRIPT)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


scorer = _load_scorer()

JP = resolve_label_set("stage3-jp")
# A tiny stand-in centroid table. The real one is keyed on raw kanji `pref|muni`; the key is opaque
# to the scorer (norm_key just strips whitespace), so ASCII keeps the fixtures readable.
CENTROIDS = {"TOKYO|CHIYODA": [139.75, 35.68, 1], "OSAKA|KITA": [135.50, 34.70, 1]}


def _row(pref: str, muni: str, tail: str, register: str | None, lon: float, lat: float) -> dict:
    """A board row whose raw is pref+muni+tail, with spans recorded by construction."""
    raw = pref + muni + tail
    row = {
        "raw": raw,
        "span_starts": [0, len(pref)],
        "span_ends": [len(pref), len(pref) + len(muni)],
        "span_tags": ["prefecture", "municipality"],
        "lon": lon,
        "lat": lat,
    }
    if register is not None:
        row["register"] = register
    return row


def _labels_from_spans(row: dict) -> list[int]:
    """Gold per-char BIO ids for a row — what a perfect model would emit."""
    ids = [JP.label_to_id["O"]] * len(row["raw"])
    for start, end, tag in zip(row["span_starts"], row["span_ends"], row["span_tags"], strict=True):
        ids[start] = JP.label_to_id[f"B-{tag}"]
        for i in range(start + 1, end):
            ids[i] = JP.label_to_id[f"I-{tag}"]
    return ids


def _predictor(correct_raws: set[str]):
    """Emit gold labels for the named rows and all-``O`` for the rest (which then fail to resolve)."""

    def predict(raw: str) -> list[int]:
        for row in ALL_ROWS:
            if row["raw"] == raw:
                return _labels_from_spans(row) if raw in correct_raws else [JP.label_to_id["O"]] * len(raw)
        raise AssertionError(f"unexpected raw {raw!r}")

    return predict


# Four registers. `native` dominates the board the way it dominates the real one (68% there).
ALL_ROWS = [
    _row("TOKYO", "CHIYODA", "1-2-3", "native", 139.75, 35.68),
    _row("TOKYO", "CHIYODA", "4-5-6", "native", 139.76, 35.69),
    _row("OSAKA", "KITA", "7-8", "native", 135.50, 34.70),
    _row("TOKYO", "CHIYODA", "2CHOME", "arabic_chome", 139.75, 35.68),
    _row("OSAKA", "KITA", "3-4-5", "compact_folded", 135.50, 34.70),
    _row("TOKYO", "CHIYODA", "3BAN16GO", "designator", 139.75, 35.68),
]
_RESOLVE = ("prefecture", "municipality")


def _score(correct: set[str], rows=None):
    return scorer.score_board(
        rows if rows is not None else ALL_ROWS,
        _predictor(correct),
        CENTROIDS,
        id_to_label=JP.id_to_label,
        resolve_tags=_RESOLVE,
    )


def test_per_register_fractions_are_computed_over_that_register_only():
    # Everything right except the single compact_folded row.
    correct = {r["raw"] for r in ALL_ROWS} - {"OSAKAKITA3-4-5"}
    result = _score(correct)

    assert result["rows"] == 6
    assert result["acceptable"] == 5
    assert result["unresolved"] == 1
    assert result["fraction"] == pytest.approx(5 / 6)

    per = result["per_register"]
    assert per["native"] == {"rows": 3, "acceptable": 3, "unresolved": 0, "fraction": 1.0}
    assert per["arabic_chome"] == {"rows": 1, "acceptable": 1, "unresolved": 0, "fraction": 1.0}
    assert per["designator"] == {"rows": 1, "acceptable": 1, "unresolved": 0, "fraction": 1.0}
    # The one that failed reads 0.0000 on its own, where the blended 0.83 would have hidden it.
    assert per["compact_folded"] == {"rows": 1, "acceptable": 0, "unresolved": 1, "fraction": 0.0}


def test_per_register_totals_partition_the_blended_totals():
    correct = {"TOKYOCHIYODA1-2-3", "TOKYOCHIYODA4-5-6", "TOKYOCHIYODA2CHOME"}
    result = _score(correct)
    per = result["per_register"].values()

    assert sum(s["rows"] for s in per) == result["rows"]
    assert sum(s["acceptable"] for s in per) == result["acceptable"]
    assert sum(s["unresolved"] for s in per) == result["unresolved"]


def test_gate_is_the_blended_number_even_when_a_register_is_wiped_out():
    """The pre-registered bar reads the blend. A dead minority register cannot flip it, by design."""
    # 5 of 6 acceptable = 0.8333 >= 0.70, with designator at 0.0000.
    correct = {r["raw"] for r in ALL_ROWS} - {"TOKYOCHIYODA3BAN16GO"}
    result = _score(correct)

    assert result["per_register"]["designator"]["fraction"] == 0.0
    assert result["fraction"] == pytest.approx(5 / 6)
    report = scorer.format_report(result)
    assert "GATE >= 0.70: PASS" in report
    # …and the diagnostic is labeled as one, so nobody quotes it as a bar.
    assert "DIAGNOSTIC, not the gate" in report


def test_gate_still_fails_on_a_bad_blend():
    correct = {"TOKYOCHIYODA1-2-3"}
    result = _score(correct)
    assert result["fraction"] == pytest.approx(1 / 6)
    assert "GATE >= 0.70: FAIL" in scorer.format_report(result)


def test_board_without_a_register_column_scores_identically_and_gets_no_breakdown():
    """The Leg-1 probe board has eight columns and no `register`. It must still read the same."""
    plain = [{k: v for k, v in row.items() if k != "register"} for row in ALL_ROWS]
    correct = {r["raw"] for r in ALL_ROWS} - {"OSAKAKITA3-4-5"}

    with_registers = _score(correct)
    without = scorer.score_board(
        plain,
        _predictor(correct),
        CENTROIDS,
        id_to_label=JP.id_to_label,
        resolve_tags=_RESOLVE,
    )

    assert without["per_register"] == {}
    for key in ("rows", "acceptable", "unresolved", "fraction"):
        assert without[key] == with_registers[key]
    assert "board carries no `register` column" in scorer.format_report(without)


def test_unresolved_rows_are_unacceptable_and_land_in_their_own_register_bucket():
    """A predicted pair absent from the centroid table is UNACCEPTABLE — the pre-registered rule."""
    result = _score(set())  # every row decodes to all-O, so every key is "|"
    assert result["unresolved"] == 6
    assert result["acceptable"] == 0
    assert result["fraction"] == 0.0
    assert result["per_register"]["native"]["unresolved"] == 3


def test_resolve_tags_select_which_spans_form_the_centroid_key():
    """stage3-jp resolves prefecture|municipality; the STAGE3 (region|locality) pair finds nothing."""
    correct = {r["raw"] for r in ALL_ROWS}
    assert _score(correct)["acceptable"] == 6

    stage3_pair = scorer.score_board(
        ALL_ROWS,
        _predictor(correct),
        CENTROIDS,
        id_to_label=JP.id_to_label,
        resolve_tags=("region", "locality"),
    )
    assert stage3_pair["acceptable"] == 0
    assert stage3_pair["unresolved"] == 6


def test_resolve_tag_defaults_track_the_label_set():
    assert scorer.RESOLVE_TAGS["stage3"] == ("region", "locality")
    assert scorer.RESOLVE_TAGS["stage3-jp"] == ("prefecture", "municipality")
