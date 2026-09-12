"""Reading rows out of one parquet file, shuffled, with the per-row filters applied.

Three shuffles happen here and they are all drawn from the caller's `rng`: row-group order within
a file, row order within a group, and file order within a source. Source weighting is NOT applied
here — that is `mixture.py`'s multinomial, and doing it per row instead produces the
`raw_share × accept_share` mix rather than the configured one.
"""

from __future__ import annotations

import random
from collections.abc import Iterator, Sequence
from pathlib import Path
from typing import Any

import pyarrow.parquet as pq

from ...labels import active_components_present
from ..augment import SPAN_KEYS

_REQUIRED_COLUMNS: tuple[str, ...] = ("raw", "tokens", "labels", "country", "source")

# v0.5.0 char-offset label columns (#519). Presence is decided PER SLICE by schema: a v0.5.0
# slice carries all three (and every row must be non-null in all three); a frozen pre-v0.5.0
# slice carries none (rows ride the legacy token path). A slice with SOME of the three is
# corrupt — loud failure, never a silent fallback.
_SPAN_COLUMNS: tuple[str, ...] = SPAN_KEYS


def _row_components_keys(labels: Sequence[str]) -> list[str]:
    """Return the unique component tags present in a row's BIO labels."""
    out: set[str] = set()
    for label in labels:
        if label == "O" or "-" not in label:
            continue
        _, tag = label.split("-", 1)
        out.add(tag)
    return list(out)


def _slice_row_iter(
    slice: Path,
    *,
    expected_source: str | None,
    rng: random.Random,
    country_weights: dict[str, float],
    max_weight: float,
    coarse_filter: bool,
) -> Iterator[dict[str, Any]]:
    """Yield filter-accepted rows from a single parquet slice, with row-group + row shuffle.

    Applies the country-weight acceptance test, (when ``coarse_filter`` is set) the
    coarse-label check, and — when ``expected_source`` is given — a per-row source equality
    check. The per-row source check matters for the 2 "transition" slices in corpus
    v0.2.0 (part-0016 and part-0259) where one source's data ends and the next begins
    mid-slice; without it the per-source iterator would yield rows from the wrong source.

    Does **not** apply source weighting — source weighting is handled at the multinomial
    sampler level in ``_raw_row_stream``, so that the observed mix matches ``source_weights``
    exactly (rather than the ``raw_share × accept_share`` shape that per-row source
    acceptance produces, which under v0.2.0's heavy raw-share skew toward BAN proved
    unreliable as a steering mechanism — PR #44).
    """
    pf = pq.ParquetFile(slice)
    # Span-column presence is a per-slice schema fact (#519): all three or none. Partial = a
    # corrupt slice; reading the survivors would silently train the wrong labels.
    schema_names = set(pf.schema_arrow.names)
    span_present = [c for c in _SPAN_COLUMNS if c in schema_names]
    if span_present and len(span_present) != len(_SPAN_COLUMNS):
        missing = [c for c in _SPAN_COLUMNS if c not in schema_names]
        raise ValueError(
            f"corrupt slice {slice}: carries span columns {span_present} but is missing {missing} "
            "— the #519 triple is all-or-none per slice"
        )
    has_spans = bool(span_present)
    columns = list(_REQUIRED_COLUMNS) + (list(_SPAN_COLUMNS) if has_spans else [])
    rg_order = list(range(pf.num_row_groups))
    rng.shuffle(rg_order)
    for rg in rg_order:
        t = pf.read_row_group(rg, columns=columns)
        raws = t["raw"]
        tokens_col = t["tokens"]
        labels_col = t["labels"]
        countries = t["country"]
        sources = t["source"]
        span_cols = {c: t[c] for c in _SPAN_COLUMNS} if has_spans else None
        idx_order = list(range(t.num_rows))
        rng.shuffle(idx_order)
        for i in idx_order:
            source = sources[i].as_py()
            if expected_source is not None and source != expected_source:
                continue
            country = countries[i].as_py()
            weight = country_weights.get(country)
            if weight is None or weight <= 0:
                continue
            if weight < max_weight and rng.random() > weight / max_weight:
                continue
            bio_labels = labels_col[i].as_py()
            if coarse_filter:
                keys = _row_components_keys(bio_labels)
                if not active_components_present(keys):
                    continue
            row = {
                "raw": raws[i].as_py(),
                "tokens": tokens_col[i].as_py(),
                "labels": bio_labels,
                "country": country,
                "source": source,
            }
            if span_cols is not None:
                spans = {c: span_cols[c][i].as_py() for c in _SPAN_COLUMNS}
                nulls = [c for c, v in spans.items() if v is None]
                if nulls:
                    raise ValueError(
                        f"corrupt row in {slice} (row-group {rg}, raw={row['raw']!r}): "
                        f"null span column(s) {nulls} in a span-schema slice — never a silent "
                        "fallback to token labels"
                    )
                # EMPTY is the other way a span-schema slice lies, and it is the quieter one. A writer
                # that projects rows without the span triple emits `[]` for all three, which passes the
                # null check above; `char_label_array_from_spans(raw, [], [], [])` then returns an
                # all-`O` array and every such row trains as "nothing here is an address component".
                # A row whose BIO labels carry a tag cannot honestly have no spans.
                if all(not v for v in spans.values()) and any(lbl != "O" for lbl in bio_labels):
                    raise ValueError(
                        f"corrupt row in {slice} (row-group {rg}, raw={row['raw']!r}): "
                        "every span column is EMPTY while the BIO labels carry a tag — the slice "
                        "declares the span triple and its writer did not populate it, so this row "
                        "would train as all-O"
                    )
                row.update(spans)
            yield row


def _source_iter(
    slices: list[Path],
    *,
    expected_source: str,
    rng: random.Random,
    country_weights: dict[str, float],
    max_weight: float,
    coarse_filter: bool,
) -> Iterator[dict[str, Any]]:
    """Yield rows from a sequence of slices, restricted to ``expected_source``.

    Slices are visited in shuffled order; within each slice, row-groups and row indices
    are also shuffled (see ``_slice_row_iter``). One row-group's worth of rows is held
    in memory at a time per source, so total RAM is bounded by the number of distinct
    sources, not by any slice-pool parameter.
    """
    order = list(slices)
    rng.shuffle(order)
    for s in order:
        yield from _slice_row_iter(
            s,
            expected_source=expected_source,
            rng=rng,
            country_weights=country_weights,
            max_weight=max_weight,
            coarse_filter=coarse_filter,
        )
