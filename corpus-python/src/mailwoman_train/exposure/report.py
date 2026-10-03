"""The exposure measurement artifact: per jurisdiction, what each pipeline stage holds and which phenomena it exercises.

Stages, in pipeline order:

``source_records``
    Records the source published that the acquisition read, such as OSM features carrying
    ``addr:housenumber``. Read from the acquisition's own stats file.
``canonical_rows``
    Rows an adapter wrote to ``canonical.jsonl`` after its refusals and deduplication.
``eligible_training_rows``
    Rows in the built corpus's ``train`` split that the training config admits: the row's country
    has a positive ``country_weights`` entry and its source a positive ``source_weights`` entry (or
    the config weights no sources).
``replayed_draws``
    Rows the training mixture draws in epoch 1, reconstructed by running the loader's sampler with
    the trainer's seed. It reconstructs the draw. The trainer's own count is ``realized_draws``.
``realized_draws``
    Rows the trainer logged as drawn. Recorded only from a trainer log.

A stage that was not measured is ``null``. A stage measured at zero is ``{"total": 0, ...}``. The two
are different facts and the report never writes one for the other.
"""

from __future__ import annotations

import json
from collections import Counter, defaultdict
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Final

from ..tokenizer.train import git_commit
from .phenomena import (
    ARITY,
    PHENOMENON_IDS,
    LocateError,
    Row,
    pair_phenomena,
    row_from_spans,
    row_phenomena,
    spans_from_components,
)

SCHEMA: Final[str] = "mailwoman.exposure/v1"

STAGES: Final[tuple[str, ...]] = (
    "source_records",
    "canonical_rows",
    "eligible_training_rows",
    "replayed_draws",
    "realized_draws",
)


@dataclass
class StageCounter:
    """Totals and phenomenon forms for one stage, keyed by jurisdiction."""

    stage: str
    totals: Counter[str] = field(default_factory=Counter)
    unreadable: Counter[str] = field(default_factory=Counter)
    forms: dict[str, dict[str, Counter[str]]] = field(default_factory=lambda: defaultdict(lambda: defaultdict(Counter)))

    def add(self, row: Row) -> None:
        self.totals[row.country] += 1
        for phenomenon, form in row_phenomena(row).items():
            self.forms[row.country][phenomenon][form] += 1

    def add_unreadable(self, country: str) -> None:
        """A row the stage holds but the predicates could not read. It counts toward the total."""
        self.totals[country] += 1
        self.unreadable[country] += 1

    def add_canonical(self, record: Mapping[str, Any]) -> None:
        country = str(record.get("country") or "").upper()
        try:
            spans = spans_from_components(str(record["raw"]), record.get("components") or {})
        except LocateError:
            self.add_unreadable(country)
            return
        self.add(Row(str(record["raw"]), country, spans))

    def add_span_row(self, record: Mapping[str, Any]) -> None:
        country = str(record.get("country") or "").upper()
        starts, ends, tags = record.get("span_starts"), record.get("span_ends"), record.get("span_tags")
        if starts is None or ends is None or tags is None:
            self.add_unreadable(country)
            return
        self.add(row_from_spans(str(record["raw"]), country, starts, ends, tags))


def count_canonical_jsonl(path: Path, stage: str = "canonical_rows") -> StageCounter:
    counter = StageCounter(stage)
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            if line.strip():
                counter.add_canonical(json.loads(line))
    return counter


def count_pairs(pairs: Iterable[tuple[Row, Row]]) -> dict[str, dict[str, int]]:
    """Relational phenomena over explicit pairs, by phenomenon and form."""
    out: dict[str, Counter[str]] = defaultdict(Counter)
    for a, b in pairs:
        for phenomenon, form in pair_phenomena(a, b).items():
            out[phenomenon][form] += 1
    return {phenomenon: dict(sorted(forms.items())) for phenomenon, forms in sorted(out.items())}


def numeric_shape_pairs(counter: StageCounter) -> dict[str, int]:
    """Cross-jurisdiction pairs available for ``numeric-shape-across-contexts`` at one stage.

    Two rows from different jurisdictions whose postcodes share one all-digit width form a pair, so the
    count for a width and two jurisdictions is the product of their row counts at that width. The pairs
    are counted rather than enumerated.
    """
    by_width: dict[str, dict[str, int]] = defaultdict(dict)
    for country, phenomena in counter.forms.items():
        for width, rows in phenomena.get("fixed-width-numeric-postcode", {}).items():
            by_width[width][country] = rows
    out: dict[str, int] = {}
    for width, countries in sorted(by_width.items()):
        codes = sorted(countries)
        for i, a in enumerate(codes):
            for b in codes[i + 1 :]:
                out[f"{width}:{a}/{b}"] = countries[a] * countries[b]
    return out


def build_report(
    counters: Iterable[StageCounter],
    *,
    source_records: Mapping[str, Mapping[str, Any]] | None = None,
    pairs: Mapping[str, Any] | None = None,
    corpus_version: str | None = None,
    training_config: str | None = None,
    label_set: Mapping[str, Any] | None = None,
    inputs: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    """Assemble the artifact from per-stage counters.

    ``source_records`` maps a jurisdiction to its acquisition stats, recorded as that stage's entry.
    Every phenomenon id appears under every jurisdiction a stage measured, so a phenomenon the stage
    holds no row of reads as an empty form map at that stage rather than being absent.
    """
    by_stage = {counter.stage: counter for counter in counters}
    unknown = set(by_stage) - set(STAGES)
    if unknown:
        raise ValueError(f"unknown stages {sorted(unknown)}")

    jurisdictions = sorted({c for counter in by_stage.values() for c in counter.totals} | set(source_records or {}))
    body: dict[str, Any] = {}
    for country in jurisdictions:
        stages: dict[str, Any] = {}
        for stage in STAGES:
            if stage == "source_records" and source_records and country in source_records:
                stages[stage] = dict(source_records[country])
                continue
            counter = by_stage.get(stage)
            stages[stage] = (
                None
                if counter is None
                else {"total": counter.totals.get(country, 0), "unreadable": counter.unreadable.get(country, 0)}
            )
        phenomena: dict[str, Any] = {}
        for phenomenon in PHENOMENON_IDS:
            entry: dict[str, Any] = {"arity": ARITY[phenomenon]}
            for stage in STAGES[1:]:
                counter = by_stage.get(stage)
                if ARITY[phenomenon] == "relational" or counter is None:
                    entry[stage] = None
                else:
                    entry[stage] = dict(sorted(counter.forms[country][phenomenon].items()))
            phenomena[phenomenon] = entry
        body[country] = {"stages": stages, "phenomena": phenomena}

    return {
        "schema": SCHEMA,
        "measured_at": datetime.now(UTC).isoformat(timespec="seconds"),
        "code_revision": git_commit(),
        "corpus_version": corpus_version,
        "training_config": training_config,
        "label_set": dict(label_set) if label_set else None,
        "inputs": dict(inputs or {}),
        "denominator": "rows per jurisdiction at each stage; each phenomenon form counts rows exercising it",
        "jurisdictions": body,
        "pairs": dict(pairs) if pairs is not None else None,
    }
