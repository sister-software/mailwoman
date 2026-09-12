"""The pre-registered read: one row at a time, folded into the blended totals and two breakdowns.

The check is the blended fraction and nothing else. Every other figure here — the per-register
split, the per-municipality macro, the gold-exact count — is a READING beside it, and none of them
can move it. `predict` is injected so all of this runs without a checkpoint and without torch.
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from .decode import decode_all_spans, haversine_km, norm_key

ACCEPT_KM = 15.0
CHECK = 0.70

# Which two predicted spans get concatenated into the centroid-table key, per label set. STAGE3 is
# the Leg-1 mapping (prefecture → region, municipality → locality); stage3-jp gives them own tags.
RESOLVE_TAGS: dict[str, tuple[str, str]] = {
    "stage3": ("region", "locality"),
    "stage3-jp": ("prefecture", "municipality"),
    # The CJK head is stage3-jp plus `locality_unit`; the JP board resolves on the same two tags.
    "stage3-cjk": ("prefecture", "municipality"),
}


@dataclass(frozen=True)
class RowOutcome:
    """One board row's read: which of the three outcomes it is, and the two keys it is bucketed by.

    `acceptable` and `unresolved` are mutually exclusive, and a row that is neither resolved to a
    centroid within the accept radius nor unresolved is simply wrong. `gold_exact` never implies
    `acceptable`: it is reported beside the pre-registered number, never folded into it.
    """

    register: str | None
    gold_municipality: str | None
    acceptable: bool
    unresolved: bool
    gold_exact: bool
    tag_hits: list[str]
    tag_totals: list[str]


def score_row(
    row: Mapping[str, Any],
    predict: Callable[[str], Sequence[int]],
    centroids: Mapping[str, Sequence[float]],
    *,
    id_to_label: Mapping[int, str],
    resolve_tags: tuple[str, str],
    accept_km: float,
) -> RowOutcome:
    """Read one board row: the resolve outcome, the per-tag hits, and the buckets it belongs to."""
    region_tag, locality_tag = resolve_tags
    raw = row["raw"]
    ids = list(predict(raw))[: len(raw)]
    predicted = decode_all_spans(raw, ids, id_to_label)
    pred = {tag: surfaces[0] for tag, surfaces in predicted.items()}

    # Per-tag exact-match diagnostics vs the board's gold spans: every gold span counts, and it hits when the
    # model emitted that exact surface under that tag anywhere in the row.
    gold_spans = [(t, raw[s:e]) for s, e, t in zip(row["span_starts"], row["span_ends"], row["span_tags"], strict=True)]
    tag_totals = [t for t, _ in gold_spans]
    tag_hits = [t for t, g in gold_spans if g in predicted.get(t, ())]
    # The resolve read keys on the FIRST span per tag on both sides, so a two-span tag reads the same way in
    # `pred` and `gold`.
    gold: dict[str, str] = {}
    for t, g in gold_spans:
        gold.setdefault(t, g)
    gold_muni = gold.get(locality_tag)

    key = norm_key(pred.get(region_tag, "") + "|" + pred.get(locality_tag, ""))
    hit = centroids.get(key)
    acceptable = hit is not None and haversine_km(hit[0], hit[1], row["lon"], row["lat"]) <= accept_km

    gold_exact = False
    if hit is None and pred.get(region_tag) == gold.get(region_tag) and pred.get(locality_tag) == gold_muni:
        # A surface the centroid table does not key (the kana register renders うんぜん市 for 雲仙市) can still
        # be read: when the predicted pair equals the gold pair span for span, the row's own kanji fields name
        # the centroid. The JP board names those fields `pref` / `muni`; the KR board `region` / `city`.
        gold_key = norm_key(
            str(row.get("pref") or row.get("region") or "") + "|" + str(row.get("muni") or row.get("city") or "")
        )
        gold_hit = centroids.get(gold_key)
        gold_exact = (
            gold_hit is not None and haversine_km(gold_hit[0], gold_hit[1], row["lon"], row["lat"]) <= accept_km
        )
    return RowOutcome(
        register=row.get("register"),
        gold_municipality=gold_muni,
        acceptable=acceptable,
        unresolved=hit is None,
        gold_exact=gold_exact,
        tag_hits=tag_hits,
        tag_totals=tag_totals,
    )


class BoardTallies:
    """The blended totals and the two breakdowns, folded one row at a time.

    The board holds out whole municipalities, and one of them carries 823 of 20,000 rows, so a
    row-weighted number moves 2 pp on a single name. The macro over municipalities is reported
    beside the blended fraction; the pre-registered check stays the blended one.
    """

    def __init__(self) -> None:
        self.rows = 0
        self.acceptable = 0
        self.unresolved = 0
        self.gold_exact = 0
        self.tag_hit: Counter[str] = Counter()
        self.tag_total: Counter[str] = Counter()
        self.reg_rows: Counter[str] = Counter()
        self.reg_acceptable: Counter[str] = Counter()
        self.reg_unresolved: Counter[str] = Counter()
        self.reg_gold_exact: Counter[str] = Counter()
        self.muni_rows: Counter[str] = Counter()
        self.muni_acceptable: Counter[str] = Counter()
        self.muni_gold_exact: Counter[str] = Counter()

    def add(self, outcome: RowOutcome) -> None:
        self.rows += 1
        self.tag_total.update(outcome.tag_totals)
        self.tag_hit.update(outcome.tag_hits)
        register, muni = outcome.register, outcome.gold_municipality
        if register is not None:
            self.reg_rows[register] += 1
        if muni is not None:
            self.muni_rows[muni] += 1
        if outcome.acceptable:
            self.acceptable += 1
            if register is not None:
                self.reg_acceptable[register] += 1
            if muni is not None:
                self.muni_acceptable[muni] += 1
        if outcome.unresolved:
            self.unresolved += 1
            if register is not None:
                self.reg_unresolved[register] += 1
        if outcome.gold_exact:
            self.gold_exact += 1
            if register is not None:
                self.reg_gold_exact[register] += 1
            if muni is not None:
                self.muni_gold_exact[muni] += 1

    def report(self) -> dict[str, Any]:
        per_register = {
            name: {
                "rows": count,
                "acceptable": self.reg_acceptable[name],
                "unresolved": self.reg_unresolved[name],
                "gold_exact": self.reg_gold_exact[name],
                "fraction": self.reg_acceptable[name] / count,
            }
            for name, count in self.reg_rows.items()
        }
        per_municipality = {
            name: {
                "rows": count,
                "acceptable": self.muni_acceptable[name],
                "gold_exact": self.muni_gold_exact[name],
                "fraction": self.muni_acceptable[name] / count,
            }
            for name, count in self.muni_rows.items()
        }
        municipality_macro = (
            sum(stats["fraction"] for stats in per_municipality.values()) / len(per_municipality)
            if per_municipality
            else 0.0
        )
        return {
            "rows": self.rows,
            "acceptable": self.acceptable,
            "gold_exact_unresolved": self.gold_exact,
            "unresolved": self.unresolved,
            "fraction": self.acceptable / self.rows if self.rows else 0.0,
            "tag_hit": self.tag_hit,
            "tag_total": self.tag_total,
            "per_register": per_register,
            "per_municipality": per_municipality,
            "municipality_macro": municipality_macro,
        }


def score_board(
    rows: Iterable[Mapping[str, Any]],
    predict: Callable[[str], Sequence[int]],
    centroids: Mapping[str, Sequence[float]],
    *,
    id_to_label: Mapping[int, str],
    resolve_tags: tuple[str, str],
    accept_km: float = ACCEPT_KM,
) -> dict[str, Any]:
    """Run the pre-registered read over ``rows``, plus the per-register split of the same outcomes.

    ``predict(raw) -> per-character label ids`` is injected so the arithmetic is testable without a
    checkpoint (and without importing torch). ``main`` supplies the real argmax decoder.

    The blended ``fraction`` is computed exactly as the pre-registered definition states —
    ``acceptable / len(rows)``, an unresolved pair counting as unacceptable. ``per_register`` is the
    same per-row outcomes bucketed by the board's ``register`` column and carries no bar.
    """
    tallies = BoardTallies()
    for row in rows:
        tallies.add(
            score_row(
                row,
                predict,
                centroids,
                id_to_label=id_to_label,
                resolve_tags=resolve_tags,
                accept_km=accept_km,
            )
        )
    return tallies.report()
