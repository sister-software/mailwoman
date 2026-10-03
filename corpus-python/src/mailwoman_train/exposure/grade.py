"""Score a checkpoint on one country's held-out rows, by phenomenon: the decoder observation of an exposure curve.

The rows come through ``iter_encoded`` on a held-out split, the trainer's own encoding path, so every
feature channel the model reads is computed as in training. Its observer receives each row before
the row's example is yielded, one row per example and in order, so a prediction stays tied to the row
it was made on and the row's phenomena from :mod:`.phenomena` select it into a group.

A row is correct when every labeled position's argmax equals its gold label. The report gives, per
phenomenon form, the rows graded and the rows correct, plus the same over all rows. Exact match is
stricter than token F1 and is what a user of the parse sees.
"""

from __future__ import annotations

import random
from collections import defaultdict
from collections.abc import Callable
from typing import Any

from .phenomena import row_from_spans, row_phenomena


def grade_heldout(
    cfg: Any,
    forward: Callable[[dict[str, Any]], Any],
    tokenizer: Any,
    *,
    country: str,
    split: str = "test",
    max_rows: int = 20000,
    batch_size: int = 128,
) -> dict[str, Any]:
    """Grade ``forward`` (a collated batch → logits) on ``country``'s rows of ``split``.

    ``cfg.data.country_weights`` is replaced by ``{country: 1.0}`` for the read and restored after, so
    only that country's held-out rows are graded.
    """
    from ..data.loader import collate, iter_encoded

    groups: dict[str, list[int]] = defaultdict(lambda: [0, 0])
    rows: list[dict[str, Any]] = []
    examples: list[Any] = []

    def score() -> None:
        logits = forward(collate(examples))
        predictions = logits.argmax(-1).cpu().tolist()
        for row, example, prediction in zip(rows, examples, predictions, strict=True):
            correct = all(p == g for p, g in zip(prediction, example.labels, strict=False) if g != -100)
            spans = (row.get("span_starts"), row.get("span_ends"), row.get("span_tags"))
            keys = ["*"]
            if all(part is not None for part in spans):
                found = row_phenomena(row_from_spans(str(row["raw"]), country, *spans))  # type: ignore[arg-type]
                keys += [f"{phenomenon}={form}" for phenomenon, form in found.items()]
            for key in keys:
                groups[key][0] += 1
                groups[key][1] += int(correct)
        rows.clear()
        examples.clear()

    original = cfg.data.country_weights
    cfg.data.country_weights = {country: 1.0}
    try:
        for example in iter_encoded(
            cfg.data, tokenizer, split=split, rng=random.Random(0), row_limit=max_rows, observer=rows.append
        ):
            examples.append(example)
            if len(examples) == batch_size:
                score()
        if examples:
            score()
    finally:
        cfg.data.country_weights = original

    return {
        "country": country,
        "split": split,
        "max_rows": max_rows,
        "groups": {
            key: {"rows": n, "correct": k, "exact_match": round(k / n, 4) if n else None}
            for key, (n, k) in sorted(groups.items())
        },
    }
