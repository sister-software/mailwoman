"""Running a batch of generation requests, checkpointed and concurrent.

Both modes had their own copy of this loop. The copies had already diverged — only one of them
noticed a truncated completion — so what they share is a function rather than a pair of matched
constants: the mode supplies a worker, and everything about resuming, writing and reporting is
here.

A worker answers `(batch_id, stats)`. Prefixing the id with `!RETRY:` leaves the batch PENDING: its
parsed rows are still written (deterministic source ids dedupe a re-emit), and the next run asks
for the rest. That is how a completion cut off at `max_tokens` stops costing the rows it dropped.
"""

from __future__ import annotations

import concurrent.futures
import json
import threading
import time
from collections import Counter
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, TypeVar

RETRY_PREFIX = "!RETRY:"

#: Every stats key that counts against a batch rather than toward it.
REJECT_KEYS = ("api_error", "bad-shape", "index-out-of-range")

Batch = TypeVar("Batch")

#: What a mode's worker answers: the batch id (prefixed to leave it pending) and its own tally.
Worker = Callable[[Batch], tuple[str, Counter[str]]]


def rejects(stats: Counter[str]) -> int:
    """Rows the run asked for and did not get, by any of the ways it can fail to get one."""
    return sum(count for key, count in stats.items() if key.startswith("reject") or key in REJECT_KEYS)


@dataclass
class Sink:
    """The two append-only files a run writes, guarded so concurrent workers do not interleave.

    Append, never truncate: a resumed run adds to what the previous one wrote, and the
    deterministic source ids are what keep a re-emitted row from becoming a duplicate.
    """

    canonical_path: Path
    raw_log_path: Path

    def __post_init__(self) -> None:
        self._canonical = self.canonical_path.open("a", encoding="utf-8")
        self._raw_log = self.raw_log_path.open("a", encoding="utf-8")
        self._canonical_lock = threading.Lock()
        self._raw_lock = threading.Lock()

    def write_rows(self, rows: Iterable[dict[str, Any]]) -> None:
        with self._canonical_lock:
            for row in rows:
                self._canonical.write(json.dumps(row, ensure_ascii=False) + "\n")
            self._canonical.flush()

    def write_response(self, entry: dict[str, Any]) -> None:
        """The raw API response, kept so a row can be traced back to the call that produced it."""
        with self._raw_lock:
            self._raw_log.write(json.dumps(entry, ensure_ascii=False) + "\n")
            self._raw_log.flush()

    def close(self) -> None:
        self._canonical.close()
        self._raw_log.close()


def load_checkpoint(path: Path) -> set[str]:
    """The batch ids a previous run completed, or an empty set on the first run."""
    if not path.exists():
        return set()
    done: set[str] = set(json.loads(path.read_text()).get("done", []))
    print(f"resuming: {len(done)} batches already complete", flush=True)
    return done


def run_batches(
    pending: Sequence[Batch],
    worker: Worker[Batch],
    *,
    done: set[str],
    checkpoint_path: Path,
    concurrency: int,
    label: str,
    sink: Sink,
) -> Counter[str]:
    """Run every pending batch, checkpointing as they land, and print the summary.

    The checkpoint is flushed every 25 completions and once at the end, so an interrupted run loses
    at most the last few ids — the rows themselves are already on disk.
    """
    stats: Counter[str] = Counter()
    checkpoint_lock = threading.Lock()
    started = time.time()
    processed = 0

    def commit(batch_id: str) -> None:
        if batch_id.startswith(RETRY_PREFIX):
            return
        with checkpoint_lock:
            done.add(batch_id)
            if len(done) % 25 == 0:
                checkpoint_path.write_text(json.dumps({"done": sorted(done)}))

    with concurrent.futures.ThreadPoolExecutor(max_workers=concurrency) as pool:
        futures = [pool.submit(worker, batch) for batch in pending]
        for future in concurrent.futures.as_completed(futures):
            batch_id, batch_stats = future.result()
            stats.update(batch_stats)
            commit(batch_id)
            processed += 1
            if processed % 5 == 0 or processed == len(pending):
                elapsed = time.time() - started
                print(
                    f"  [{processed}/{len(pending)}] ok={stats['ok']} reject={rejects(stats)} "
                    f"truncated={stats['finish:length']} "
                    f"elapsed={elapsed:.0f}s  rps={stats['ok'] / max(elapsed, 1):.1f}",
                    flush=True,
                )

    checkpoint_path.write_text(json.dumps({"done": sorted(done)}))
    sink.close()
    print(f"\n{label} generation complete.")
    print(f"  ok rows: {stats['ok']}")
    print(f"  rejects: {dict((k, v) for k, v in stats.items() if k.startswith('reject') or k in REJECT_KEYS)}")
    print(f"  output: {sink.canonical_path}")
    return stats
