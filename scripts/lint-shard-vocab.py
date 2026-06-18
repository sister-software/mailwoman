#!/usr/bin/env python3
"""#511 base-consistency lint, GENERALIZED — any synthetic shard vs the base corpus.

The #511 lesson (Madison-as-street, and the v1.7.0 venue-vocab catch): a synthetic shard must not label a
token a tag the BASE corpus dominantly labels something else, or training gets conflicting gradients on the
same token and the minority (the shard) loses. This generalizes scripts/lint-venue-vocab.py from a hardcoded
token list to "read a shard's own (token -> tag) and check every token against the base."

For each token the shard emits, it computes the shard's dominant tag, then scans a stratified sample of the
base parquet shards for that token's tag distribution, and FLAGS a contradiction when the base dominantly
(>= --threshold) assigns a DIFFERENT tag with enough support (>= --min-count). Tag = the BIO label minus its
B-/I- prefix. Source-aware: the base is source-homogeneous + ordered (the #511 scan lesson), so it samples
across sources rather than the head.

Usage:
  python3 scripts/lint-shard-vocab.py \
      --shard /mnt/playpen/.../v0.6.1-boundary-stress/.../train/part-boundary-stress-train.parquet \
      [--base-version v0.5.0] [--threshold 0.7] [--min-count 50] [--parts-per-source 4]

CAVEAT (v1 — a COARSE screen). It samples --parts-per-source parts UNIFORMLY per source, but the base is
source-homogeneous and the big sources (ban 146 parts, nad 378) carry most of the true distribution. A
uniform sample UNDERSAMPLES them, so it can FALSE-flag a MINORITY-source token — e.g. a French city that is
locality-dominant in the ban block reads "street" from US street-contexts (validated 2026-06-18: it flagged
Marseille/Toulon/Avignon "street", all locality in ban). That is the very #511 trap this lints for, applied
to the lint itself: trust a flag for a MAJORITY-source token; for a minority-source flag, re-check it
source-scoped against that token's own block (the scripts/lint-venue-vocab.py pattern). Pure-numeric tokens
are excluded (house_number/postcode values are context-determined, not lexical). And an affix-split flag
(street_suffix vs base "street") is EXPECTED — the loader's affix-relabel handles it. Proper fix (a
follow-up): sample proportional to source size, or scan per-token source-scoped.
"""

from __future__ import annotations

import argparse
import glob
from collections import Counter, defaultdict

import pyarrow.parquet as pq


def strip_bio(label: str) -> str:
    return label[2:] if label[:2] in ("B-", "I-") else label


def dominant(counter: Counter) -> tuple[str, int, float]:
    total = sum(counter.values())
    if total == 0:
        return ("", 0, 0.0)
    tag, n = counter.most_common(1)[0]
    return (tag, total, n / total)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--shard", required=True, help="the synthetic shard parquet (tokens + labels columns)")
    ap.add_argument("--base-version", default="v0.5.0", help="base corpus version under corpus/versioned/")
    ap.add_argument(
        "--base-root",
        default="/mnt/playpen/mailwoman-data/corpus/versioned",
        help="root holding the versioned corpora",
    )
    ap.add_argument("--threshold", type=float, default=0.7, help="base-dominant fraction to call a contradiction")
    ap.add_argument("--min-count", type=int, default=50, help="min base occurrences to judge a token")
    ap.add_argument("--parts-per-source", type=int, default=4, help="base parts sampled per source")
    args = ap.parse_args()

    # 1. the shard's own (token -> dominant tag)
    st = pq.read_table(args.shard, columns=["tokens", "labels"])
    shard_tags: dict[str, Counter] = defaultdict(Counter)
    for toks, labs in zip(st.column("tokens").to_pylist(), st.column("labels").to_pylist()):
        for w, l in zip(toks, labs):
            if w.isdigit():
                continue  # numbers are context-determined (house_number/postcode), not lexical vocab
            shard_tags[w][strip_bio(l)] += 1
    shard_vocab = set(shard_tags)
    print(f"shard: {st.num_rows} rows, {len(shard_vocab)} unique tokens")

    # 2. sample base parts across sources (source-homogeneous blocks; don't undersample minorities)
    base_glob = f"{args.base_root}/{args.base_version}/corpus-{args.base_version}/train/*.parquet"
    parts = sorted(glob.glob(base_glob))
    if not parts:
        raise SystemExit(f"no base parts at {base_glob}")
    bysrc: dict[str, list[str]] = defaultdict(list)
    for p in parts:
        bysrc[pq.read_table(p, columns=["source"]).column("source")[0].as_py()].append(p)
    sample = [p for ps in bysrc.values() for p in ps[: args.parts_per_source]]
    print(f"base {args.base_version}: scanning {len(sample)} parts across {len(bysrc)} sources")

    # 3. tally the shard's tokens in the base
    base_tags: dict[str, Counter] = defaultdict(Counter)
    for p in sample:
        t = pq.read_table(p, columns=["tokens", "labels"])
        for toks, labs in zip(t.column("tokens").to_pylist(), t.column("labels").to_pylist()):
            for w, l in zip(toks, labs):
                if w in shard_vocab:
                    base_tags[w][strip_bio(l)] += 1

    # 4. compare; flag contradictions
    flagged = []
    for w in shard_vocab:
        s_tag, _, _ = dominant(shard_tags[w])
        b_tag, b_total, b_frac = dominant(base_tags.get(w, Counter()))
        if b_total < args.min_count or not b_tag:
            continue
        if b_tag != s_tag and b_frac >= args.threshold:
            flagged.append((w, s_tag, b_tag, b_frac, b_total))

    flagged.sort(key=lambda r: (-r[4], -r[3]))
    if not flagged:
        print(f"\n✅ NO contradictions (base-dominant >= {args.threshold:.0%}, support >= {args.min_count}) — shard is base-consistent")
    else:
        print(f"\n⚠️  {len(flagged)} CONTRADICTION(S) — shard tag vs base-dominant tag:")
        print(f"  {'token':18} {'shard':14} {'base-dominant':22} {'support'}")
        for w, s_tag, b_tag, b_frac, b_total in flagged:
            print(f"  {w:18} {s_tag:14} {b_tag} ({b_frac:.0%}){'':<{max(0,22-len(b_tag)-7)}} {b_total}")
    raise SystemExit(1 if flagged else 0)


if __name__ == "__main__":
    main()
