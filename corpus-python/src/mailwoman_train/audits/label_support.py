"""Count the validation rows that hold each head label, and refuse a launch below a declared floor.

`evaluate()` averages `macro_f1` over every label with support above zero, each as one equal term.
A label held by three validation rows therefore moves the macro score as much as a label held by
two thousand, and its F1 swings with each of those three rows. `po_box` entered v7.2.0's macro
score from 3 rows of 4,096 (#2438).

The count reads the validation set the trainer scores: the same split, row limit and seed, through
`iter_encoded`. A row holds a label when any of its pieces carries that label's `B-` tag. The
per-country floors in `validation_coverage` read the parquet directly, because they ask what the
split contains. This audit asks what the trainer's draw contains, which is a property of the sampler.
"""

from __future__ import annotations

import json
import random
from collections import Counter
from collections.abc import Sequence
from pathlib import Path
from typing import Any

from ..config import LabelSupportConfig, load_config
from ..data.loader import IGNORE_INDEX, iter_encoded
from ..labels import resolve_label_set
from ..tokenizer import Tokenizer


class LabelSupportError(RuntimeError):
    """A declared per-label validation floor is not met. Carries the report so a reader has the numbers."""

    def __init__(self, message: str, report: dict[str, Any]) -> None:
        super().__init__(message)
        self.report = report


def head_labels(label_ids: Sequence[int], bio_labels: Sequence[str]) -> set[str]:
    """The component tags a row holds, read from the `B-` tags among its piece labels."""
    present: set[str] = set()
    for label_id in label_ids:
        if label_id == IGNORE_INDEX:
            continue
        name = bio_labels[label_id]
        if name.startswith("B-"):
            present.add(name[2:])
    return present


def count_label_rows(
    cfg: Any, tokenizer: Tokenizer | None, *, split: str, row_limit: int | None, seed: int
) -> tuple[int, Counter[str]]:
    """Rows in the trainer's draw of `split`, and the rows that hold each label.

    The draw is the one `evaluate()` scores when `split` is `val`: `cfg.data.val_rows` rows under
    `cfg.train.seed + 1`.
    """
    bio = resolve_label_set(getattr(cfg.data, "label_set", "stage3")).bio_labels
    rows_with: Counter[str] = Counter()
    total = 0
    for example in iter_encoded(cfg.data, tokenizer, split=split, rng=random.Random(seed), row_limit=row_limit):
        total += 1
        rows_with.update(head_labels(example.labels, bio))
    return total, rows_with


def failing_label_floors(counts: dict[str, dict[str, int]], required: list[LabelSupportConfig]) -> list[dict[str, Any]]:
    """The declared floors the counted splits miss.

    `counts` maps a split to its per-label row counts. A label the split holds no row for counts as
    zero rows, and a split that was not counted is reported as unmeasured rather than as zero.
    """
    failures: list[dict[str, Any]] = []
    for entry in required:
        measured = counts.get(entry.split)
        if measured is None:
            failures.append(
                {
                    "label": entry.label,
                    "split": entry.split,
                    "rows": None,
                    "min_rows": entry.min_rows,
                    "because": f"split {entry.split!r} was not counted",
                }
            )
            continue
        rows = measured.get(entry.label, 0)
        if rows < entry.min_rows:
            failures.append(
                {
                    "label": entry.label,
                    "split": entry.split,
                    "rows": rows,
                    "min_rows": entry.min_rows,
                    "because": f"{rows:,} rows hold {entry.label} against a floor of {entry.min_rows:,}",
                }
            )
    return failures


def run(config_path: Path, *, json_path: Path | None = None) -> dict[str, Any]:
    """Count each declared split's label support, print it, write the report and raise on a missed floor.

    The report is written and printed before the raise, because a reader needs the numbers that
    failed rather than the fact that something did.
    """
    cfg = load_config(config_path)
    required = cfg.data.required_validation_label_support
    tokenizer = Tokenizer(Path(cfg.data.tokenizer_dir) / "tokenizer.model")
    splits = sorted({entry.split for entry in required}) or ["val"]
    counts: dict[str, dict[str, int]] = {}
    totals: dict[str, int] = {}

    for split in splits:
        seed = cfg.train.seed + 1 if split == "val" else cfg.train.seed + 2
        total, rows_with = count_label_rows(cfg, tokenizer, split=split, row_limit=cfg.data.val_rows, seed=seed)
        totals[split] = total
        counts[split] = dict(rows_with)

    failures = failing_label_floors(counts, required)
    report: dict[str, Any] = {
        "config": config_path.name,
        "corpus_dir": cfg.data.corpus_dir,
        "splits": {split: {"rows": totals[split], "rows_with_label": counts[split]} for split in splits},
        "required_validation_label_support": {
            "declared": [
                {"label": entry.label, "split": entry.split, "min_rows": entry.min_rows} for entry in required
            ],
            "failures": failures,
        },
    }

    print(f"label support — {config_path.name}")
    for split in splits:
        print(f"  {split} — {totals[split]:,} rows")
        for label, rows in sorted(counts[split].items(), key=lambda item: item[1]):
            print(f"    {label:>20s} {rows:>9,} {rows / totals[split] if totals[split] else 0.0:>9.3%}")
    if required:
        print(f"\n  declared label floors ({len(required)}):")
        for entry in required:
            rows = counts.get(entry.split, {}).get(entry.label, 0)
            print(f"    {entry.label} / {entry.split}: {rows:,} rows (floor {entry.min_rows:,})")

    if json_path is not None:
        json_path.parent.mkdir(parents=True, exist_ok=True)
        json_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
        print(f"\nwrote {json_path}")

    if failures:
        lines = "\n".join(f"  {f['label']} / {f['split']}: {f['because']}" for f in failures)
        raise LabelSupportError(
            f"{len(failures)} of {len(required)} declared label-support floors are not met:\n{lines}", report
        )

    return report
