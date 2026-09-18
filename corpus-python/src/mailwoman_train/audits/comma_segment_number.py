"""Count what a bare number standing alone between commas teaches.

WHY THIS EXISTS. `301 College Ave, 101, Athens, GA 30601` is the second surface #2298 proposes to
teach, where `101` is a secondary unit. Unlike the `#101` form it carries no token that decides the
reading: the same surface — a digit group alone in its own comma segment — is already attested as a
HOUSE NUMBER (`15, 07691 Portopetro, Illes Balears, Spain`) and as a POSTCODE. So the rule has to be
read against the rows it would newly claim, and that is a count.

LEADING AND NON-LEADING ARE SEPARATE COUNTS. A number opening the row is the house-number surface
several recipes already emit and is not in competition with the proposed unit. a number in a LATER
segment is the exact shape, and its current readings are the evidence the decision rests on.

The sampling mirrors `audit_epoch_mixture` and the other two censuses — same stream, same seed
convention, same budget — so a count here is comparable with an exposure reported there.
"""

from __future__ import annotations

import argparse
import json
import random
from collections.abc import Iterable, Iterator
from itertools import islice
from pathlib import Path
from typing import Any

from ..config import load_config
from ..data.emit import EmitPolicy, emit_row
from ..data.loader import _raw_row_stream
from ..data.source_reps import resolve_config_reps


def _bare(token: str) -> str | None:
    """The digits of a token that is a digit group with at most a trailing comma, else None."""
    body = token[:-1] if token.endswith(",") else token

    return body if body.isdigit() else None


def isolated_positions(tokens: list[str]) -> list[int]:
    """Every index holding a digit group that is ALONE in its comma segment.

    A segment is delimited by the comma the previous token carries and by the comma this token
    carries, so a number between two other words in the same segment — `Apt 101 Athens` — is not one.
    """
    out: list[int] = []

    for index, token in enumerate(tokens):
        if _bare(token) is None:
            continue

        opens = index == 0 or tokens[index - 1].endswith(",")
        closes = token.endswith(",") or index == len(tokens) - 1

        if opens and closes:
            out.append(index)

    return out


def audit_rows(rows: Iterable[dict[str, Any]]) -> dict[str, dict[str, int]]:
    """Count isolated bare numbers by the tag they open, split into `leading` and `later`."""
    counts: dict[str, dict[str, int]] = {"leading": {}, "later": {}}

    for row in rows:
        tokens = row.get("tokens") or []
        labels = row.get("labels") or []

        for index in isolated_positions(tokens):
            label = labels[index] if index < len(labels) else "O"

            if not label.startswith("B-"):
                continue

            where = "leading" if index == 0 else "later"
            tag = label[2:]
            counts[where][tag] = counts[where].get(tag, 0) + 1

    return counts


def census(
    corpus_dir: Path,
    *,
    seed: int,
    draws: int,
    country_weights: dict[str, float],
    source_weights: dict[str, float] | None,
    coarse_filter: bool,
    augment: dict[str, float],
    augment_exclude_sources: tuple[str, ...] = (),
) -> dict[str, Any]:
    """Count isolated bare numbers over ``draws`` rows, at the draw level and again at the emitted level."""

    def stream(rng: random.Random) -> Iterator[dict[str, Any]]:
        return _raw_row_stream(
            Path(corpus_dir),
            "train",
            rng=rng,
            country_weights=country_weights,
            source_weights=source_weights,
            coarse_filter=coarse_filter,
        )

    drawn_rows = list(islice(stream(random.Random(seed)), draws))
    drawn = audit_rows(drawn_rows)

    rng2 = random.Random(seed)
    policy = EmitPolicy(
        directional_prob=augment["directional"],
        region_prob=augment["region"],
        glue_prob=augment["glue"],
        case_prob=augment["case"],
        punct_drop_prob=augment["punct_drop"],
        upper_case_prob=augment["upper_case"],
        ordinal_prob=augment["ordinal"],
        excluded_sources=frozenset(augment_exclude_sources),
    )

    def emitted_stream() -> Iterator[dict[str, Any]]:
        produced = 0

        for row in stream(rng2):
            for out in emit_row(row, rng2, policy):
                if produced >= draws:
                    return

                produced += 1

                yield out

    emitted = audit_rows(emitted_stream())

    return {
        "meta": {
            "seed": seed,
            "draws_requested": draws,
            "rows_drawn": len(drawn_rows),
            "corpus_dir": str(corpus_dir),
        },
        "draw_level": drawn,
        "emitted_level": emitted,
    }


def run(config_path: Path, *, json_path: Path | None = None, draws: int | None = None) -> dict[str, Any]:
    """Load a training config, count both levels over one epoch, print the table and return the report."""
    cfg = load_config(config_path)
    corpus_dir = Path(cfg.data.corpus_dir)
    resolve_config_reps(cfg, corpus_dir)

    epoch_rows = draws or getattr(cfg.data, "train_rows_per_epoch", None)

    if not epoch_rows:
        raise ValueError("config has no train_rows_per_epoch — pass --draws for the epoch length")

    report = census(
        corpus_dir,
        seed=cfg.train.seed + 1,
        draws=int(epoch_rows),
        country_weights=cfg.data.country_weights,
        source_weights=cfg.data.source_weights,
        coarse_filter=cfg.data.coarse_filter,
        augment={
            "directional": cfg.data.augment_directional_prob,
            "region": cfg.data.augment_region_prob,
            "glue": cfg.data.augment_glue_prob,
            "case": getattr(cfg.data, "augment_case_prob", 0.0),
            "punct_drop": cfg.data.augment_punct_drop_prob,
            "upper_case": getattr(cfg.data, "augment_upper_case_prob", 0.0),
            "ordinal": cfg.data.augment_ordinal_prob,
        },
        augment_exclude_sources=tuple(getattr(cfg.data, "augment_exclude_sources", ()) or ()),
    )

    meta = report["meta"]
    print(f"comma-segment number census — {config_path.name}")
    print(f"  seed {meta['seed']}, {meta['rows_drawn']:,} rows drawn\n")

    for level in ("draw_level", "emitted_level"):
        print(f"  {level.replace('_', ' ')}:")

        for where in ("leading", "later"):
            tags = report[level][where]
            total = sum(tags.values())
            print(f"    {where:9s} {total:>10,}")

            for tag, count in sorted(tags.items(), key=lambda item: item[1], reverse=True):
                print(f"      {tag:20s} {count:>10,}")

        print()

    if json_path is not None:
        json_path.parent.mkdir(parents=True, exist_ok=True)
        json_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
        print(f"wrote {json_path}")

    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("config", type=Path)
    parser.add_argument("--json", type=Path, default=None)
    parser.add_argument("--draws", type=int, default=None)
    args = parser.parse_args()

    run(args.config, json_path=args.json, draws=args.draws)


if __name__ == "__main__":
    main()
