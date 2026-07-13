"""Probe 0b (parity campaign, night-1): fit CRF transition log-probs by counting label bigrams.

The shipped decoder applies ``crf-transitions.json`` when the weights package carries one
(``neural/weights.ts`` ``readCrfTransitions`` -> ``classifier.ts`` Viterbi potentials), but CRF
TRAINING diverged long ago (``crf_loss_weight=0.0`` since v0.5.0) and no bundle ships the file —
decode runs on the structural BIO mask alone. This fits transitions the cheap way: Laplace-smoothed
bigram counts over a training corpus's gold ``labels`` sequences, emitted in the EXACT label order
of a model-card's ``labels`` array (index-aligned with the model's logit heads).

Usage:
    python -m mailwoman_train.fit_crf_transitions \
        --parquet-glob '/data/corpus/**/*.parquet' \
        --model-card <candidate>/model-card.json \
        --out <candidate>/crf-transitions.json \
        [--temperature 1.0]

``--temperature`` scales the log-probs (the emissions were not trained against these potentials, so
the relative magnitude is a free parameter; 1.0 = raw log-probs).
"""

from __future__ import annotations

import argparse
import glob
import json
import math
from pathlib import Path

import pyarrow.parquet as pq  # type: ignore[import-not-found]


def fit(parquet_files: list[str], labels: list[str], temperature: float) -> dict:
    index = {label: i for i, label in enumerate(labels)}
    n = len(labels)
    # Laplace smoothing: every transition starts at 1 so unseen-but-legal moves stay finite.
    counts = [[1.0] * n for _ in range(n)]
    starts = [1.0] * n
    ends = [1.0] * n
    rows = 0
    skipped_labels: set[str] = set()

    for path in parquet_files:
        table = pq.read_table(path, columns=["labels"])

        for value in table.column("labels"):
            seq = [str(v) for v in value.as_py()]
            ids = []

            for label in seq:
                if label not in index:
                    skipped_labels.add(label)
                    ids = []
                    break

                ids.append(index[label])

            if not ids:
                continue

            rows += 1
            starts[ids[0]] += 1.0
            ends[ids[-1]] += 1.0

            for prev, nxt in zip(ids, ids[1:], strict=False):
                counts[prev][nxt] += 1.0

    def log_normalize(row: list[float]) -> list[float]:
        total = sum(row)
        logs = [math.log(c / total) for c in row]
        # Row-max centering: the decoder's structural mask uses 0 = permitted, so bolt-on potentials
        # must be RELATIVE penalties (best transition = 0), not absolute log-probs — raw logP puts
        # -2..-16 on every step and swamps the emissions the model was calibrated for.
        peak = max(logs)

        return [temperature * (v - peak) for v in logs]

    return {
        "labels": labels,
        "rows_counted": rows,
        "skipped_label_vocab": sorted(skipped_labels),
        "transitions": [log_normalize(row) for row in counts],
        "start_transitions": log_normalize(starts),
        "end_transitions": log_normalize(ends),
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--parquet-glob", required=True)
    ap.add_argument("--model-card", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--temperature", type=float, default=1.0)
    ap.add_argument(
        "--max-files",
        type=int,
        default=0,
        help="Deterministic head-sample of the sorted file list (0 = all). Bigram counts stabilize "
        "around ~1M rows; sampling beats grinding a multi-GB corpus for a 33x33 table.",
    )
    args = ap.parse_args()

    card = json.loads(args.model_card.read_text())
    labels = card["labels"]
    files = sorted(glob.glob(args.parquet_glob, recursive=True))

    if args.max_files > 0:
        files = files[: args.max_files]

    if not files:
        raise SystemExit(f"no parquet files match {args.parquet_glob}")

    result = fit(files, labels, args.temperature)
    args.out.write_text(json.dumps(result))
    print(
        f"fit {len(labels)}x{len(labels)} transitions from {result['rows_counted']} rows "
        f"({len(files)} files) -> {args.out}"
    )

    if result["skipped_label_vocab"]:
        print(f"  rows skipped for out-of-card labels: {result['skipped_label_vocab']}")


if __name__ == "__main__":
    main()
