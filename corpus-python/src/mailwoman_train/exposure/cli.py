"""Write the exposure measurement artifact for one set of inputs.

Usage::

    python -m mailwoman_train.exposure.cli \\
        --canonical <staging>/osm/canonical.jsonl \\
        --source-stats RU=$MAILWOMAN_DATA_ROOT/db/osm/corpus/osm-ru.corpus.jsonl.stats.json \\
        --config src/mailwoman_train/configs/<config>.yaml \\
        --json exposure.json

``--canonical`` measures the ``canonical_rows`` stage. ``--config`` measures ``eligible_training_rows``
over the config's ``train`` split and ``replayed_draws`` over epoch 1 of its mixture. A stage whose
input is not given is written as ``null``.
"""

from __future__ import annotations

import argparse
import json
import random
from collections.abc import Iterator
from itertools import islice
from pathlib import Path
from typing import Any

from .report import StageCounter, build_report, count_canonical_jsonl, numeric_shape_pairs


def _source_stats(entries: list[str]) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for entry in entries:
        country, _, path = entry.partition("=")
        stats = json.loads(Path(path).read_text(encoding="utf-8"))
        extract = stats.get("extract") or {}
        matched = sum(layer.get("matched", 0) for layer in extract.values()) if extract else None
        out[country.upper()] = {
            "total": matched if matched is not None else stats.get("read"),
            "read": stats.get("read"),
            "written": stats.get("written"),
            "without_street": stats.get("noStreet"),
            "extract": extract or None,
            "stats_path": path,
            "receipt": stats.get("receipt"),
        }
    return out


def _eligible_rows(cfg: Any, countries: set[str] | None) -> Iterator[dict[str, Any]]:
    """Every train-split row whose country and source the config weights above zero."""
    import pyarrow as pa
    import pyarrow.compute as pc
    import pyarrow.parquet as pq

    from ..data.loader.corpus_files import _parquet_paths

    country_weights: dict[str, float] = cfg.data.country_weights
    source_weights: dict[str, float] | None = cfg.data.source_weights
    admitted = [c for c, w in country_weights.items() if w > 0 and (countries is None or c in countries)]
    wanted = pa.array(admitted)
    columns = ["raw", "country", "source", "span_starts", "span_ends", "span_tags"]
    for path in _parquet_paths(Path(cfg.data.corpus_dir), "train"):
        for batch in pq.ParquetFile(path).iter_batches(columns=columns, batch_size=65536):
            # The country filter runs in Arrow, so a corpus of hundreds of millions of rows converts only
            # the admitted countries' rows to Python.
            kept = batch.filter(pc.is_in(pc.utf8_upper(batch.column("country")), value_set=wanted))
            for record in kept.to_pylist():
                country = str(record.get("country") or "").upper()
                if countries is not None and country not in countries:
                    continue
                if country_weights.get(country, 0) <= 0:
                    continue
                if source_weights is not None and source_weights.get(record.get("source"), 0) <= 0:
                    continue
                yield record


def _replayed_rows(cfg: Any, draws: int) -> Iterator[dict[str, Any]]:
    """Epoch 1's draws, reconstructed with the trainer's seed (``cfg.train.seed + 1``)."""
    from ..data.loader.mixture import _raw_row_stream

    stream = _raw_row_stream(
        Path(cfg.data.corpus_dir),
        "train",
        rng=random.Random(cfg.train.seed + 1),
        country_weights=cfg.data.country_weights,
        source_weights=cfg.data.source_weights,
        coarse_filter=cfg.data.coarse_filter,
    )
    return islice(stream, draws)


def main(argv: list[str] | None = None) -> dict[str, Any]:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--canonical", type=Path, action="append", default=[])
    parser.add_argument("--source-stats", action="append", default=[], metavar="CC=PATH")
    parser.add_argument("--config", type=Path, default=None)
    parser.add_argument("--countries", default=None, help="comma-separated ISO codes limiting the corpus stages")
    parser.add_argument("--draws", type=int, default=None, help="epoch length; defaults to train_rows_per_epoch")
    parser.add_argument("--corpus-version", default=None)
    parser.add_argument(
        "--replay-only",
        action="store_true",
        help="measure only the replayed draws; the eligible stage reads every admitted row of the corpus",
    )
    parser.add_argument("--json", type=Path, required=True)
    args = parser.parse_args(argv)

    counters: list[StageCounter] = []
    inputs: dict[str, str] = {}
    if args.canonical:
        canonical = StageCounter("canonical_rows")
        for path in args.canonical:
            part = count_canonical_jsonl(path)
            canonical.totals.update(part.totals)
            canonical.unreadable.update(part.unreadable)
            canonical.systems.update(part.systems)
            for country, phenomena in part.forms.items():
                for phenomenon, forms in phenomena.items():
                    canonical.forms[country][phenomenon].update(forms)
        counters.append(canonical)
        inputs["canonical_rows"] = ", ".join(str(p) for p in args.canonical)

    label_set = None
    if args.config is not None:
        from ..config import load_config
        from ..data.source_reps import resolve_config_reps
        from ..semantic_tags import label_set_contract

        cfg = load_config(args.config)
        resolve_config_reps(cfg, Path(cfg.data.corpus_dir))
        countries = {c.strip().upper() for c in args.countries.split(",")} if args.countries else None
        label_set = label_set_contract(getattr(cfg.data, "label_set", "stage3"))

        if not args.replay_only:
            eligible = StageCounter("eligible_training_rows")
            for record in _eligible_rows(cfg, countries):
                eligible.add_span_row(record)
            counters.append(eligible)

        draws = args.draws or getattr(cfg.data, "train_rows_per_epoch", None)
        if draws:
            replayed = StageCounter("replayed_draws")
            for record in _replayed_rows(cfg, int(draws)):
                if countries is None or str(record.get("country") or "").upper() in countries:
                    replayed.add_span_row(record)
            counters.append(replayed)
        inputs["corpus_dir"] = str(cfg.data.corpus_dir)

    pairs: dict[str, Any] | None = None
    if args.canonical:
        pairs = {
            "numeric-shape-across-contexts": {"canonical_rows": numeric_shape_pairs(counters[0])},
            # Each OSM object yields one rendering, so no canonical row has a second-script twin.
            "ordering-reverses-with-script": {
                "canonical_rows": {"paired_examples": 0},
                "basis": "the OSM adapter emits one rendering per object",
            },
        }

    report = build_report(
        counters,
        pairs=pairs,
        source_records=_source_stats(args.source_stats) or None,
        corpus_version=args.corpus_version,
        training_config=str(args.config) if args.config else None,
        label_set=label_set,
        inputs=inputs,
    )
    args.json.parent.mkdir(parents=True, exist_ok=True)
    args.json.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"wrote {args.json}")
    return report


if __name__ == "__main__":
    main()
