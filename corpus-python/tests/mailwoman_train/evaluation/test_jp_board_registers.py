"""Tests the per-register breakdown of the JP board score.

The pass check is ``acceptable / rows`` over the whole board against a 0.70 bar, and an unresolved
pair counts as unacceptable. The per-register split is a diagnostic. It must partition the same
outcomes and must never change the check. A board without a ``register`` column scores the same
and gets no breakdown.

``score_board`` takes an injected ``predict``, so these tests run on a synthetic board without a
checkpoint or torch.
"""

from __future__ import annotations

import pytest

from mailwoman_train.evaluation import jp_probe_board as scorer
from mailwoman_train.labels import resolve_label_set

JP = resolve_label_set("stage3-jp")
# The real centroid table is keyed on kanji `pref|muni`. The scorer treats the key as opaque, so ASCII
# keys keep the fixtures readable.
CENTROIDS = {"TOKYO|CHIYODA": [139.75, 35.68, 1], "OSAKA|KITA": [135.50, 34.70, 1]}


def _row(pref: str, muni: str, tail: str, register: str | None, lon: float, lat: float) -> dict:
    """Build a board row from prefecture, municipality and tail, with prefecture and municipality spans."""
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
    """Return the gold per-character BIO label ids for a row."""
    ids = [JP.label_to_id["O"]] * len(row["raw"])
    for start, end, tag in zip(row["span_starts"], row["span_ends"], row["span_tags"], strict=True):
        ids[start] = JP.label_to_id[f"B-{tag}"]
        for i in range(start + 1, end):
            ids[i] = JP.label_to_id[f"I-{tag}"]
    return ids


def _predictor(correct_raws: set[str]):
    """Return a predictor that emits gold labels for ``correct_raws`` and all ``O`` for other rows."""

    def predict(raw: str) -> list[int]:
        for row in ALL_ROWS:
            if row["raw"] == raw:
                return _labels_from_spans(row) if raw in correct_raws else [JP.label_to_id["O"]] * len(raw)
        raise AssertionError(f"unexpected raw {raw!r}")

    return predict


# The board has four registers, and `native` holds the most rows, as on the real board.
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
    # Every row is correct except the compact_folded row.
    correct = {r["raw"] for r in ALL_ROWS} - {"OSAKAKITA3-4-5"}
    result = _score(correct)

    assert result["rows"] == 6
    assert result["acceptable"] == 5
    assert result["unresolved"] == 1
    assert result["fraction"] == pytest.approx(5 / 6)

    per = result["per_register"]
    assert per["native"] == {"rows": 3, "acceptable": 3, "unresolved": 0, "gold_exact": 0, "fraction": 1.0}
    assert per["arabic_chome"] == {"rows": 1, "acceptable": 1, "unresolved": 0, "gold_exact": 0, "fraction": 1.0}
    assert per["designator"] == {"rows": 1, "acceptable": 1, "unresolved": 0, "gold_exact": 0, "fraction": 1.0}
    assert per["compact_folded"] == {"rows": 1, "acceptable": 0, "unresolved": 1, "gold_exact": 0, "fraction": 0.0}


def test_per_register_totals_partition_the_blended_totals():
    correct = {"TOKYOCHIYODA1-2-3", "TOKYOCHIYODA4-5-6", "TOKYOCHIYODA2CHOME"}
    result = _score(correct)
    per = result["per_register"].values()

    assert sum(s["rows"] for s in per) == result["rows"]
    assert sum(s["acceptable"] for s in per) == result["acceptable"]
    assert sum(s["unresolved"] for s in per) == result["unresolved"]


def test_check_is_the_blended_number_even_when_a_register_is_wiped_out():
    """Pass the check on the blended fraction even when one register scores zero."""
    # Five of six rows are acceptable (0.8333), and the designator register scores 0.
    correct = {r["raw"] for r in ALL_ROWS} - {"TOKYOCHIYODA3BAN16GO"}
    result = _score(correct)

    assert result["per_register"]["designator"]["fraction"] == 0.0
    assert result["fraction"] == pytest.approx(5 / 6)
    report = scorer.format_report(result)
    assert "CHECK >= 0.70: PASS" in report
    # The report labels the per-register split as a diagnostic.
    assert "DIAGNOSTIC, not the check" in report


def test_check_still_fails_on_a_bad_blend():
    correct = {"TOKYOCHIYODA1-2-3"}
    result = _score(correct)
    assert result["fraction"] == pytest.approx(1 / 6)
    assert "CHECK >= 0.70: FAIL" in scorer.format_report(result)


def test_board_without_a_register_column_scores_identically_and_gets_no_breakdown():
    """Score a board without a `register` column the same and omit the breakdown."""
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
    """Count a predicted pair that is absent from the centroid table as unacceptable."""
    result = _score(set())  # Every row decodes to all `O`, so every key is "|".
    assert result["unresolved"] == 6
    assert result["acceptable"] == 0
    assert result["fraction"] == 0.0
    assert result["per_register"]["native"]["unresolved"] == 3


def test_resolve_tags_select_which_spans_form_the_centroid_key():
    """Resolve stage3-jp rows by prefecture and municipality. The stage3 region and locality pair finds no row."""
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


def test_every_same_tag_gold_span_is_scored_against_every_predicted_run():
    # The row has two `municipality` spans, as a KR address can have two `dependent_locality` spans. A model
    # that labels both scores 2 of 2, and the first span still forms the centroid key.
    raw = "TOKYO CHIYODA KANDA"
    row = {
        "raw": raw,
        "span_starts": [0, 6, 14],
        "span_ends": [5, 13, 19],
        "span_tags": ["prefecture", "municipality", "municipality"],
        "lon": 139.75,
        "lat": 35.68,
    }
    ids = [JP.label_to_id["O"]] * len(raw)
    for start, end, tag in zip(row["span_starts"], row["span_ends"], row["span_tags"], strict=True):
        ids[start] = JP.label_to_id[f"B-{tag}"]
        for i in range(start + 1, end):
            ids[i] = JP.label_to_id[f"I-{tag}"]

    # The served projection joins same-tag runs separated only by whitespace, so the joined surface is also decoded.
    assert scorer.decode_all_spans(raw, ids, JP.id_to_label) == {
        "prefecture": ["TOKYO"],
        "municipality": ["CHIYODA", "KANDA", "CHIYODA KANDA"],
    }
    assert scorer.decode_spans(raw, ids, JP.id_to_label) == {"prefecture": "TOKYO", "municipality": "CHIYODA"}

    result = scorer.score_board([row], lambda _raw: ids, CENTROIDS, id_to_label=JP.id_to_label, resolve_tags=_RESOLVE)
    assert result["tag_total"]["municipality"] == 2
    assert result["tag_hit"]["municipality"] == 2
    assert result["fraction"] == 1.0
    assert result["per_municipality"]["CHIYODA"]["rows"] == 1

    # When only the second run is labeled, the first gold span misses and the second hits.
    partial = list(ids)
    for i in range(6, 13):
        partial[i] = JP.label_to_id["O"]
    result = scorer.score_board(
        [row], lambda _raw: partial, CENTROIDS, id_to_label=JP.id_to_label, resolve_tags=_RESOLVE
    )
    assert result["tag_total"]["municipality"] == 2
    assert result["tag_hit"]["municipality"] == 1


def test_a_multi_token_gold_span_hits_when_only_whitespace_splits_the_predicted_runs():
    # The unit `1층 141호` is one gold span, and the model labels the space `O`. The decoder returns both runs and
    # their joined surface. Runs separated by any other character stay separate.
    raw = "X 1층 141호 Y"
    ids = [JP.label_to_id["O"]] * len(raw)
    for start, end in ((2, 4), (5, 9)):
        ids[start] = JP.label_to_id["B-building_name"]
        for i in range(start + 1, end):
            ids[i] = JP.label_to_id["I-building_name"]

    assert scorer.decode_all_spans(raw, ids, JP.id_to_label)["building_name"] == ["1층", "141호", "1층 141호"]

    row = {"raw": raw, "span_starts": [2], "span_ends": [9], "span_tags": ["building_name"], "lon": 0.0, "lat": 0.0}
    result = scorer.score_board([row], lambda _raw: ids, CENTROIDS, id_to_label=JP.id_to_label, resolve_tags=_RESOLVE)
    assert result["tag_hit"]["building_name"] == 1

    # Runs split by a letter decode as two spans.
    raw2 = "1층X141호"
    ids2 = [JP.label_to_id["B-building_name"], JP.label_to_id["I-building_name"], JP.label_to_id["O"]]
    ids2 += [JP.label_to_id["B-building_name"]] + [JP.label_to_id["I-building_name"]] * 3
    assert scorer.decode_all_spans(raw2, ids2, JP.id_to_label)["building_name"] == ["1층", "141호"]


def test_municipality_macro_weights_each_held_out_municipality_once():
    # CHIYODA has 4 of 6 rows and KITA has 2. With KITA wrong, the blended fraction drops by a third and the
    # municipality macro drops by half.
    chiyoda = {r["raw"] for r in ALL_ROWS if "CHIYODA" in r["raw"]}
    result = _score(chiyoda)

    assert result["fraction"] == pytest.approx(4 / 6)
    assert result["per_municipality"]["CHIYODA"] == {"rows": 4, "acceptable": 4, "gold_exact": 0, "fraction": 1.0}
    assert result["per_municipality"]["KITA"] == {"rows": 2, "acceptable": 0, "gold_exact": 0, "fraction": 0.0}
    assert result["municipality_macro"] == pytest.approx(0.5)

    report = scorer.format_report(result)
    assert "municipality macro" in report
    assert "KITA" in report.split("lowest five")[1]


#: A kana-register row whose predicted surface misses the centroid table. Its `pref` and `muni`
#: kanji fields do match, and `gold_exact` reads those fields.
KANA_ROW = {
    **_row("とうきょう", "ちよだ", "1-2-3", "kana", 139.75, 35.68),
    "pref": "TOKYO",
    "muni": "CHIYODA",
}


def _score_kana() -> dict:
    return scorer.score_board(
        [KANA_ROW],
        lambda _raw: _labels_from_spans(KANA_ROW),
        CENTROIDS,
        id_to_label=JP.id_to_label,
        resolve_tags=_RESOLVE,
    )


def test_a_gold_exact_row_is_counted_beside_the_check_and_never_inside_it():
    """Report `gold_exact` separately and keep it out of the acceptable count."""
    result = _score_kana()

    assert result["gold_exact_unresolved"] == 1
    assert result["unresolved"] == 1
    assert result["acceptable"] == 0, "gold_exact must not count toward the pre-registered number"
    assert result["fraction"] == 0.0
    assert result["per_register"]["kana"] == {
        "rows": 1,
        "acceptable": 0,
        "unresolved": 1,
        "gold_exact": 1,
        "fraction": 0.0,
    }
    assert result["per_municipality"]["ちよだ"] == {"rows": 1, "acceptable": 0, "gold_exact": 1, "fraction": 0.0}


def test_a_gold_exact_row_needs_its_own_coordinate_within_the_radius():
    """Require the row's coordinate to lie within the radius of its gold centroid."""
    far = {**KANA_ROW, "lon": 0.0, "lat": 0.0}
    result = scorer.score_board(
        [far],
        lambda _raw: _labels_from_spans(far),
        CENTROIDS,
        id_to_label=JP.id_to_label,
        resolve_tags=_RESOLVE,
    )

    assert result["unresolved"] == 1
    assert result["gold_exact_unresolved"] == 0
