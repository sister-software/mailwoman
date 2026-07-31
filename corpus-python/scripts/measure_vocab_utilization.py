"""Task #25 (SP vocab-pruning probe) — fired-set measurement over the full training feed.

Walks every train shard of a corpus manifest, encodes each `raw` with the shipped tokenizer, and
accumulates per-id fire counts. Counted at the unit the model reads: `encode()` output ids
(feedback-count-at-the-unit-the-model-reads). Full feed, no sampling — the pre-registration
(docs/superpowers/plans/2026-07-31-sp-vocab-pruning-preregistration.md) explains why a sampled
fired-set would defeat the probe's own point.

Output: an .npz with `counts` (int64[vocab]) + a JSON sidecar with the run parameters.

Usage:
    python corpus-python/scripts/measure_vocab_utilization.py \
        --manifest $MAILWOMAN_DATA_ROOT/corpus/versioned/v0.15.0-venue/corpus-v0.15.0-venue/MANIFEST.json \
        --tokenizer neural-weights-en-us/tokenizer.model \
        --out $MAILWOMAN_DATA_ROOT/scratch-vocab-prune/utilization-v0150-venue.npz \
        [--workers 14] [--data-root-remap /data:/mnt/playpen/mailwoman-data]
"""

from __future__ import annotations

import argparse
import json
import os
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

import numpy as np

_SP = None
_TOKENIZER_PATH: str | None = None


def _init_worker(tokenizer_path: str) -> None:
    global _SP, _TOKENIZER_PATH
    import sentencepiece as spm

    _SP = spm.SentencePieceProcessor()
    _SP.LoadFromFile(tokenizer_path)
    _TOKENIZER_PATH = tokenizer_path


def _count_shard(shard_path: str, vocab_size: int) -> np.ndarray:
    """Encode every `raw` in one parquet shard; return int64 fire counts."""
    from itertools import chain

    import pyarrow.parquet as pq

    counts = np.zeros(vocab_size, dtype=np.int64)
    pf = pq.ParquetFile(shard_path)

    for batch in pf.iter_batches(columns=["raw"], batch_size=65536):
        raws = batch.column(0).to_pylist()
        id_lists = _SP.encode(raws)  # type: ignore[union-attr]
        # Flatten via C-speed chain + fromiter, then one bincount — the per-id python loop was the
        # bottleneck (a ~6h pace over 8B ids; this path measures ~20-30 min on 13 workers).
        flat = np.fromiter(chain.from_iterable(id_lists), dtype=np.int64)
        counts += np.bincount(flat, minlength=vocab_size)

    return counts


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--tokenizer", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--workers", type=int, default=max(2, (os.cpu_count() or 4) - 2))
    parser.add_argument(
        "--data-root-remap",
        default="/data:" + os.environ.get("MAILWOMAN_DATA_ROOT", "/mnt/playpen/mailwoman-data"),
        help="colon-separated FROM:TO prefix remap for manifest shard paths",
    )
    args = parser.parse_args()

    import sentencepiece as spm

    sp = spm.SentencePieceProcessor()
    sp.LoadFromFile(args.tokenizer)
    vocab_size = sp.get_piece_size()

    manifest = json.loads(Path(args.manifest).read_text())
    src, dst = args.data_root_remap.split(":", 1)
    shards = [s["path"].replace(src, dst, 1) for s in manifest["shards"] if s["split"] == "train"]
    missing = [s for s in shards if not os.path.exists(s)]

    if missing:
        raise SystemExit(f"{len(missing)} shard paths missing locally, first: {missing[0]}")

    total_rows = manifest.get("total_rows")
    print(f"[utilization] {len(shards)} train shards, {total_rows:,} rows, vocab {vocab_size}, workers {args.workers}")

    counts = np.zeros(vocab_size, dtype=np.int64)
    t0 = time.time()
    done = 0

    with ProcessPoolExecutor(max_workers=args.workers, initializer=_init_worker, initargs=(args.tokenizer,)) as pool:
        futures = {pool.submit(_count_shard, s, vocab_size): s for s in shards}

        for future in as_completed(futures):
            counts += future.result()
            done += 1

            if done % 25 == 0 or done == len(shards):
                fired = int((counts > 0).sum())
                rate = done / (time.time() - t0)
                print(
                    f"[utilization] {done}/{len(shards)} shards ({rate:.1f}/s) — fired {fired}/{vocab_size} "
                    f"({100 * fired / vocab_size:.1f}%)",
                    flush=True,
                )

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(out, counts=counts)
    sidecar = {
        "manifest": args.manifest,
        "corpus_version": manifest.get("corpus_version"),
        "tokenizer": args.tokenizer,
        "vocab_size": vocab_size,
        "train_shards": len(shards),
        "total_rows": total_rows,
        "fired": int((counts > 0).sum()),
        "elapsed_s": round(time.time() - t0, 1),
    }
    out.with_suffix(".json").write_text(json.dumps(sidecar, indent=1) + "\n")
    print(
        f"[utilization] wrote {out} — fired {sidecar['fired']}/{vocab_size} ({100 * sidecar['fired'] / vocab_size:.2f}%)"
    )


if __name__ == "__main__":
    main()
