"""Count how many corpus rows the anchor painter actually PAINTS, per lookup.

The insurance against repeating the 2026-08-05 GB defect
(``docs/records/evals/2026-08-05-en-gb-anchor-off.md``). That defect was invisible for 60,000 steps
because nothing ever asked the question this script asks: *given this shard and this
``anchor_lookup_path``, how many rows put a non-zero value into the anchor channel?* The answer for
every GB shard against ``pilot-anchor-lookup.json`` is ZERO, and a zero is not a smaller number — it
is the channel being switched off for that country while the config still says ``use_postcode_anchor:
true``.

Run it before a launch, once per shard whose country you expect the anchor to serve. A zero on a
shard you expected to paint is a STOP, not a warning: either the lookup lacks that country's keys or
the key normalization diverged.

WHAT IT EXERCISES. The real train-side code, not a re-implementation:
``mailwoman_train.postcode_shapes.collect_matches`` for the spans (``anchor_paint_mode: shaped``) and
``mailwoman_train.tokenizer._paint_anchor_chars`` for the lookup + normalization. The only thing
skipped is the char->piece projection, which cannot turn a painted row into an unpainted one (it
copies per-char values onto pieces).

    python3 corpus-python/scripts/count_painted_anchor_rows.py \
      --lookup $MAILWOMAN_DATA_ROOT/anchor/staging-2026-08-05/pilot-anchor-lookup-v2-2026-08-05.json \
      --shard $MAILWOMAN_DATA_ROOT/corpus/shards/synth-gb-v1.jsonl \
      --limit 100000

Exits non-zero when a shard paints zero rows (``--allow-zero`` to survey instead of gate).
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

from mailwoman_train.data_loader import load_anchor_lookup  # noqa: E402
from mailwoman_train.postcode_shapes import collect_matches  # noqa: E402
from mailwoman_train.tokenizer import ANCHOR_FEATURE_DIM, _paint_anchor_chars  # noqa: E402


def count_shard(
    shard: Path,
    lookup: dict[str, tuple[dict[str, float], float, float]],
    limit: int | None,
) -> dict[str, int]:
    """Walk a JSONL shard and count rows by what the painter does to them."""
    stats = {"rows": 0, "shaped": 0, "painted": 0, "spans": 0, "spans_hit": 0, "gold_postcode": 0}
    zero = [0.0] * ANCHOR_FEATURE_DIM
    with shard.open(encoding="utf-8") as fh:
        for line in fh:
            if limit is not None and stats["rows"] >= limit:
                break
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            raw = row.get("raw") or ""
            stats["rows"] += 1
            if (row.get("components") or {}).get("postcode"):
                stats["gold_postcode"] += 1

            matches = collect_matches(raw)
            if matches:
                stats["shaped"] += 1
            stats["spans"] += len(matches)

            char_feat: list[list[float]] = [zero] * len(raw)
            char_conf: list[float] = [0.0] * len(raw)
            for m in matches:
                before = sum(char_conf)
                _paint_anchor_chars(raw, m.start, m.end, lookup, char_feat, char_conf)
                if sum(char_conf) > before:
                    stats["spans_hit"] += 1
            if any(char_conf):
                stats["painted"] += 1
    return stats


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--lookup", required=True, help="anchor lookup JSON (the config's anchor_lookup_path)")
    ap.add_argument("--shard", required=True, action="append", help="JSONL shard; repeatable")
    ap.add_argument("--limit", type=int, default=None, help="rows per shard (default: all)")
    ap.add_argument("--allow-zero", action="store_true", help="survey mode — do not fail on a zero")
    args = ap.parse_args()

    lookup = load_anchor_lookup(args.lookup)
    letter_bearing = sum(1 for k in lookup if any("A" <= c <= "Z" for c in k))
    print(f"lookup {args.lookup}")
    print(f"  keys {len(lookup):,}   letter-bearing {letter_bearing:,}")

    zeroes: list[str] = []
    for shard_path in args.shard:
        shard = Path(shard_path)
        stats = count_shard(shard, lookup, args.limit)
        rows = stats["rows"] or 1
        print(f"\nshard {shard.name}  rows {stats['rows']:,}")
        print(f"  gold postcode component : {stats['gold_postcode']:,} ({100 * stats['gold_postcode'] / rows:.1f}%)")
        print(f"  shape-detected a span   : {stats['shaped']:,} ({100 * stats['shaped'] / rows:.1f}%)")
        print(f"  PAINTED (lookup hit)    : {stats['painted']:,} ({100 * stats['painted'] / rows:.1f}%)")
        print(f"  spans {stats['spans']:,}  spans that hit the lookup {stats['spans_hit']:,}")
        if stats["painted"] == 0:
            zeroes.append(shard.name)

    if zeroes and not args.allow_zero:
        print(f"\nZERO PAINTED ROWS on: {', '.join(zeroes)} — the anchor channel is OFF for this shard.")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
