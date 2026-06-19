#!/usr/bin/env python3
"""#511 base-consistency lint, GENERALIZED + COUNTRY-SCOPED (v2) — any synthetic shard vs the base.

The #511 lesson: a synthetic shard must not label a token a tag the BASE dominantly labels something else,
or training gets conflicting gradients on the same token and the minority (the shard) loses. This reads a
shard's own (token -> tag) and checks each token against the base.

WHY v2 IS COUNTRY-SCOPED + FULL-COUNT (the night-2026-06-18 lesson, learned the hard way over three tries):
a token's correct tag is COUNTRY-specific — "Paris" is locality in FR data and street in US "Paris Ave";
"Marion" is a US town AND many US "Marion" streets. So:
  1. A cross-COUNTRY aggregate mis-judges any country-specific token (v1 uniform AND a proportional retry
     both false-flagged FR cities as "street" from US street-contexts).
  2. A SMALL sample is street-BIASED regardless, because the street sources (tiger 39 + nad 378 parts) dwarf
     the locality sources (a small US-scoped spot-check read Indianapolis 54% street vs its true 219700:29
     LOCALITY).
The fix: tally each shard token's base tag SCOPED to the country the shard uses it in (the base has a
`country` column), over a LARGE/FULL scan (--fraction, default 1.0). Pure-numeric tokens excluded
(house_number/postcode are context-determined). An affix-split flag (shard street_suffix/_prefix vs base
"street") is EXPECTED — the loader's affix-relabel handles it; weigh those separately.

Usage:
  python3 scripts/lint-shard-vocab.py --shard <shard.parquet> [--base-version v0.5.0] [--fraction 1.0]
      [--threshold 0.7] [--min-count 50]
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
    ap.add_argument("--shard", required=True, help="the synthetic shard parquet (tokens + labels + country)")
    ap.add_argument("--base-version", default="v0.5.0", help="base corpus version under corpus/versioned/")
    ap.add_argument("--base-root", default="/mnt/playpen/mailwoman-data/corpus/versioned", help="versioned-corpora root")
    ap.add_argument("--threshold", type=float, default=0.7, help="base-dominant fraction to call a contradiction")
    ap.add_argument("--min-count", type=int, default=50, help="min COUNTRY-SCOPED base occurrences to judge a token")
    ap.add_argument("--fraction", type=float, default=1.0, help="fraction of base parts to scan (1.0=full; a small sample is street-biased)")
    args = ap.parse_args()

    # 1. the shard's own (token -> dominant tag) + the COUNTRIES it uses each token in
    st = pq.read_table(args.shard, columns=["tokens", "labels", "country"])
    shard_tags: dict[str, Counter] = defaultdict(Counter)
    shard_countries: dict[str, set] = defaultdict(set)
    for toks, labs, c in zip(
        st.column("tokens").to_pylist(), st.column("labels").to_pylist(), st.column("country").to_pylist()
    ):
        for w, l in zip(toks, labs):
            if w.isdigit():
                continue  # numbers are context-determined (house_number/postcode), not lexical vocab
            shard_tags[w][strip_bio(l)] += 1
            shard_countries[w].add(c)
    shard_vocab = set(shard_tags)
    print(f"shard: {st.num_rows} rows, {len(shard_vocab)} unique tokens")

    # 2. base parts — FULL by default; --fraction<1 takes a proportional per-source slice (still big)
    parts = sorted(glob.glob(f"{args.base_root}/{args.base_version}/corpus-{args.base_version}/train/*.parquet"))
    if not parts:
        raise SystemExit("no base parts found")
    if args.fraction < 1.0:
        bysrc: dict[str, list[str]] = defaultdict(list)
        for p in parts:
            bysrc[pq.read_table(p, columns=["source"]).column("source")[0].as_py()].append(p)
        parts = [p for ps in bysrc.values() for p in ps[: max(2, round(len(ps) * args.fraction))]]
    print(f"base {args.base_version}: scanning {len(parts)} parts (fraction={args.fraction}), COUNTRY-scoped")

    # 3. tally each shard token's base tag, SCOPED to the country the shard uses it in
    base_tags: dict[str, Counter] = defaultdict(Counter)
    for i, p in enumerate(parts):
        t = pq.read_table(p, columns=["tokens", "labels", "country"])
        for toks, labs, c in zip(
            t.column("tokens").to_pylist(), t.column("labels").to_pylist(), t.column("country").to_pylist()
        ):
            for w, l in zip(toks, labs):
                if w in shard_vocab and c in shard_countries[w]:
                    base_tags[w][strip_bio(l)] += 1
        if (i + 1) % 100 == 0:
            print(f"  ...{i + 1}/{len(parts)} parts")

    # 4. compare; flag contradictions (affix-split is expected — surfaced but tagged)
    flagged, affix = [], []
    for w in shard_vocab:
        s_tag, _, _ = dominant(shard_tags[w])
        b_tag, b_total, b_frac = dominant(base_tags.get(w, Counter()))
        if b_total < args.min_count or not b_tag or b_tag == s_tag or b_frac < args.threshold:
            continue
        row = (w, s_tag, b_tag, b_frac, b_total)
        (affix if s_tag in ("street_suffix", "street_prefix") and b_tag == "street" else flagged).append(row)

    for label, rows in (("CONTRADICTION", flagged), ("affix-split (EXPECTED — affix-relabel handles)", affix)):
        if not rows:
            continue
        rows.sort(key=lambda r: (-r[4], -r[3]))
        print(f"\n{'⚠️ ' if label.startswith('CONTRA') else '· '}{len(rows)} {label}:")
        for w, s_tag, b_tag, b_frac, b_total in rows:
            print(f"  {w:18} shard={s_tag:14} base={b_tag} ({b_frac:.0%}, n={b_total})")
    if not flagged:
        print(f"\n✅ NO real contradictions (country-scoped, threshold {args.threshold:.0%}, support {args.min_count}) — shard base-consistent")
    raise SystemExit(1 if flagged else 0)


if __name__ == "__main__":
    main()
