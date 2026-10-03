"""Count rows where a bare number occupies a comma-delimited segment.

The `301 College Ave, 101, Athens, GA 30601` surface is the second form proposal #2298 would teach,
with `101` as a secondary unit. Unlike `#101`, this form has no token that determines its reading.
The same form, a digit group by itself in its comma segment, also appears as a house number
(`15, 07691 Portopetro, Illes Balears, Spain`) and as a postcode. The audit counts rows that the
proposed rule would newly claim.

The audit reports leading and later positions separately. A number at the start of a row is the
house-number form that several recipes already emit. A number in a later segment has the shape under
review. Their current readings inform the decision.

The sample follows `audit_epoch_mixture` and the other two censuses: it uses the same stream, seed
convention and budget. Those settings make its count comparable with an exposure reported there.
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
from .epoch_mixture.passes import config_augment, config_augment_exclude_sources


def _bare(token: str) -> str | None:
    """The digits of a token that is a digit group with at most a trailing comma, else None."""
    body = token[:-1] if token.endswith(",") else token

    return body if body.isdigit() else None


def isolated_positions(tokens: list[str]) -> list[int]:
    """Every index where a digit group occupies its own comma segment.

    A segment begins at the comma before the token and ends at the comma after it. A number between
    two other words in the same segment — `Apt 101 Athens` — does not occupy its own segment.
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
        augment=config_augment(cfg.data),
        augment_exclude_sources=config_augment_exclude_sources(cfg.data),
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
