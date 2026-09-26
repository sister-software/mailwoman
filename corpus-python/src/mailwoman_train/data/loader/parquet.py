"""Reading rows out of one parquet file, shuffled, with the per-row filters applied.

Three shuffles happen here and they are all drawn from the caller's `rng`: row-group order within
a file, row order within a group, and file order within a source. Source weighting is not applied
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

# Char-offset label columns. Presence is decided per file by schema: a file carries all three, with
# every row non-null in all three, or none, and rows then ride the legacy token path. A file with
# some of the three is corrupt.
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


def _file_row_iter(
    path: Path,
    *,
    expected_source: str | None,
    rng: random.Random,
    country_weights: dict[str, float],
    max_weight: float,
    coarse_filter: bool,
) -> Iterator[dict[str, Any]]:
    """Yield filter-accepted rows from a single parquet file, with row-group and row shuffle.

    Applies the country-weight acceptance test, the coarse-label check when ``coarse_filter`` is set,
    and a per-row source equality check when ``expected_source`` is given — a file can span sources,
    so without it the per-source iterator would yield rows from the wrong source.

    Does **not** apply source weighting; that is the multinomial sampler in ``_raw_row_stream``, which
    makes the observed mix match ``source_weights`` exactly.
    """
    pf = pq.ParquetFile(path)
    # Span-column presence is a per-file schema fact: all three or none. A partial file is corrupt,
    # and reading the survivors would silently train the wrong labels.
    schema_names = set(pf.schema_arrow.names)
    span_present = [c for c in _SPAN_COLUMNS if c in schema_names]
    if span_present and len(span_present) != len(_SPAN_COLUMNS):
        missing = [c for c in _SPAN_COLUMNS if c not in schema_names]
        raise ValueError(
            f"corrupt parquet file {path}: carries span columns {span_present} but is missing {missing} "
            "— the #519 triple is all-or-none per file"
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
                        f"corrupt row in {path} (row-group {rg}, raw={row['raw']!r}): "
                        f"null span column(s) {nulls} in a span-schema file — never a silent "
                        "fallback to token labels"
                    )
                # Empty is the quieter way a span-schema file lies: a writer that projects rows without
                # the span triple emits `[]` for all three, which passes the null check above and then
                # trains as all-`O`. A row whose BIO labels carry a tag cannot honestly have no spans.
                if all(not v for v in spans.values()) and any(lbl != "O" for lbl in bio_labels):
                    raise ValueError(
                        f"corrupt row in {path} (row-group {rg}, raw={row['raw']!r}): "
                        "every span column is EMPTY while the BIO labels carry a tag — the file "
                        "declares the span triple and its writer did not populate it, so this row "
                        "would train as all-O"
                    )
                row.update(spans)
            yield row


def _source_iter(
    paths: list[Path],
    *,
    expected_source: str,
    rng: random.Random,
    country_weights: dict[str, float],
    max_weight: float,
    coarse_filter: bool,
) -> Iterator[dict[str, Any]]:
    """Yield rows from a sequence of parquet files, restricted to ``expected_source``.

    Files, row-groups and row indices are all visited in shuffled order (see ``_file_row_iter``). One
    row-group's worth of rows is held in memory at a time per source, so total RAM is bounded by the
    number of distinct sources rather than by any file-pool parameter.

    A draw reads one row-group, and rows are ordered by country within a source, so a draw sees only
    the countries in that row-group; shuffling file order moves which row-group that is without
    widening it. ``docs/engineering/reference/corpus-draw-coverage.mdx`` records the measurement and
    the candidate repairs.
    """
    order = list(paths)
    rng.shuffle(order)
    for s in order:
        yield from _file_row_iter(
            s,
            expected_source=expected_source,
            rng=rng,
            country_weights=country_weights,
            max_weight=max_weight,
            coarse_filter=coarse_filter,
        )
