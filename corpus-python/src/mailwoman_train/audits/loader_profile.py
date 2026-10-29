"""Time the training loader's host-side cost per batch, split into the sampler and everything after it.

The training step waits on the loader for each batch: the sampler (`iter_rows`: parquet reads, the shuffle buffer,
augmentation and relabeling), then the encoder and the batch assembly (`iter_batches`), then the conversion to
tensors (`to_tensor_batch`). This tool draws the same seeded train rows twice, once through the sampler alone and
once through `iter_batches`, so the difference between the two is the encoder's share.

It reports, for one config on the host it runs on:

- `init_s`: from building the loader's inputs to the first batch, which loads the lexicons and fills the shuffle
  buffer;
- `sampler_ms_per_batch`: the sampler alone, after its first row;
- `loader_ms_per_batch`: `iter_batches`, after its first batch;
- `to_tensor_ms_per_batch`: `to_tensor_batch` to the CPU;
- `host_ms_per_batch`: the loader and the tensor conversion together, the host time a training step waits for;
- `rss_after_init_mb` and `rss_after_run_mb`: resident memory read from `/proc/self/statm`, and `peak_rss_mb` from
  `ru_maxrss`, which is the process's peak and not its steady size.

Usage: `python -m mailwoman_train.audits.loader_profile --config <yaml> [--batches 40] [--set data.key=value]`
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import random
import resource
import sys
import time
from pathlib import Path
from typing import Any

import torch

from ..config import Config
from ..data.loader import build_row_encoder, iter_batches, iter_rows
from ..data.loader.encode import sampler_inputs
from ..train.batch import to_tensor_batch
from .encoder_parity import prepare_config

_CPU = torch.device("cpu")


def resident_mb() -> float:
    """The process's current resident set in MB."""
    pages = int(Path("/proc/self/statm").read_text().split()[1])
    return pages * os.sysconf("SC_PAGE_SIZE") / 1e6


def peak_mb() -> float:
    """The process's peak resident set in MB (`ru_maxrss` is in KiB on Linux)."""
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * 1024 / 1e6


def loader_input(cfg: Config) -> Any:
    """The row encoder `iter_batches` takes for this config."""
    from ..tokenizer import Tokenizer

    return build_row_encoder(cfg.data, Tokenizer(Path(cfg.data.tokenizer_dir) / "tokenizer.model"))


def time_sampler(cfg: Config, *, seed: int, rows: int) -> tuple[float, int]:
    """Seconds to draw `rows` rows after the first, and the rows drawn."""
    stream = iter_rows(Path(cfg.data.corpus_dir), "train", rng=random.Random(seed), **sampler_inputs(cfg.data))
    next(stream)
    started = time.perf_counter()
    drawn = 0
    for _ in stream:
        drawn += 1
        if drawn >= rows:
            break
    return time.perf_counter() - started, drawn


def profile(cfg: Config, *, batches: int, seed: int) -> dict[str, Any]:
    """The stage timings and memory of one config's train loader over `batches` batches after the first."""
    batch_size = cfg.train.batch_size
    started = time.perf_counter()
    encoder = loader_input(cfg)
    stream = iter_batches(cfg, encoder, split="train", batch_size=batch_size, seed=seed)
    first = next(stream)
    init_s = time.perf_counter() - started
    rss_after_init = resident_mb()
    to_tensor_batch(first, _CPU)

    loader_s = 0.0
    tensor_s = 0.0
    rows = 0
    for _ in range(batches):
        started = time.perf_counter()
        batch = next(stream)
        loader_s += time.perf_counter() - started
        started = time.perf_counter()
        to_tensor_batch(batch, _CPU)
        tensor_s += time.perf_counter() - started
        rows += len(batch["locale_ids"])
    sampler_s, sampled = time_sampler(cfg, seed=seed, rows=rows)
    per_batch = 1e3 * batch_size
    return {
        "batch_size": batch_size,
        "batches": batches,
        "rows": rows,
        "init_s": round(init_s, 2),
        "sampler_ms_per_batch": round(sampler_s / sampled * per_batch, 2),
        "loader_ms_per_batch": round(loader_s / rows * per_batch, 2),
        "to_tensor_ms_per_batch": round(tensor_s / rows * per_batch, 2),
        "host_ms_per_batch": round((loader_s + tensor_s) / rows * per_batch, 2),
        "rss_after_init_mb": round(rss_after_init, 1),
        "rss_after_run_mb": round(resident_mb(), 1),
        "peak_rss_mb": round(peak_mb(), 1),
        "cpu_count": os.cpu_count(),
        "python": platform.python_version(),
        "torch_threads": torch.get_num_threads(),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--batches", type=int, default=40)
    parser.add_argument("--seed", type=int, default=43)
    parser.add_argument("--set", dest="overrides", action="append", default=[], help="section.key=value")
    parser.add_argument("--out", type=Path, default=None)
    args = parser.parse_args(argv)
    cfg = prepare_config(args.config, args.overrides)
    report = {
        "config": str(args.config),
        "overrides": args.overrides,
        **profile(cfg, batches=args.batches, seed=args.seed),
    }
    text = json.dumps(report, indent=1)
    if args.out is not None:
        args.out.write_text(text + "\n", encoding="utf-8")
    print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
