#!/usr/bin/env python3
"""
@copyright Sister Software
@license AGPL-3.0
@author Teffen Ellis, et al.

Build the confidence-calibration set for task #59 — a 50/50 blend of OpenAddresses
(real, held-out) and training-corpus (in-domain, full-tag gold) addresses. The output
is a flat JSONL the TS collector (`collect-span-confidences.ts`) runs the model over to
pair each predicted span's raw softmax confidence with a correct/incorrect label.

Why 50/50 OA + corpus (the split the task names):
  - OA gives REAL, genuinely-held-out addresses (the model never trained on them) but
    only PARTIAL gold — OpenAddresses carries {locality, region, postcode}, nothing else.
    So OA rows can only grade those three tags. This is the honest, un-gamed half.
  - Corpus gives FULL-tag gold (all 33 stage-3 BIO labels, incl. street decomposition /
    po_box / intersection) reconstructed from the tokens+labels, so the calibrator covers
    tags OA can't see. Caveat: the model trained on this corpus, so corpus rows are mildly
    OPTIMISTIC (seen-data confidence runs high). The fitter reports an OA-only ECE
    alongside the combined number precisely so that optimism is visible, not hidden.

Each output row: {raw, gold: [[tag, value], ...], country, source, partial}
  - `partial=true` (OA): grade ONLY tags present in `gold`; a predicted tag absent from
    gold is UNLABELABLE (skipped), not counted wrong — OA's silence isn't a negative.
  - `partial=false` (corpus): full gold; a predicted tag absent from gold IS wrong.

Corpus rows are filtered to >=2 distinct component tags so the corpus half reflects real
multi-component addresses, not the bare "France" / "Paris" admin-name rows the wof-admin
adapter emits in bulk (those would inflate easy high-confidence-correct cases).

Usage:
  python3 scripts/eval/build-calibration-set.py \
    --corpus /mnt/playpen/mailwoman-data/corpus/versioned/v0.4.0/corpus-v0.4.0/train/part-0000.parquet \
    --out data/eval/calibration/calibration-set.jsonl \
    [--oa-us 2000 --oa-fr 1000 --oa-de 500 --oa-nl 500 --corpus-n 4000 --seed 20260607]
"""

import argparse
import json
import os
import random
from pathlib import Path

import pyarrow.parquet as pq

REPO = Path(__file__).resolve().parents[2]
OA_DIR = REPO / "data" / "eval" / "external"
OA_FILES = {
    "US": "openaddresses-us-sample.jsonl",
    "FR": "openaddresses-fr-sample.jsonl",
    "DE": "openaddresses-de-sample.jsonl",
    "NL": "openaddresses-nl-sample.jsonl",
}
# Only these three tags are present in OA gold (`expected`); grade nothing else for OA rows.
OA_TAGS = ("locality", "region", "postcode")


def load_oa(country: str, n: int, rng: random.Random) -> list[dict]:
    path = OA_DIR / OA_FILES[country]
    rows = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
    rng.shuffle(rows)
    out = []
    for r in rows[:n]:
        gold = [[t, str(r["expected"][t])] for t in OA_TAGS if r.get("expected", {}).get(t)]
        if not gold:
            continue
        out.append({"raw": r["input"], "gold": gold, "country": country, "source": "oa", "partial": True})
    return out


def reconstruct_spans(tokens: list[str], labels: list[str]) -> list[list[str]]:
    """Group a BIO token/label stream into [tag, value] spans (value = space-joined tokens)."""
    spans: list[list[str]] = []
    cur_tag: str | None = None
    cur_toks: list[str] = []

    def flush():
        nonlocal cur_tag, cur_toks
        if cur_tag and cur_toks:
            spans.append([cur_tag, " ".join(cur_toks)])
        cur_tag, cur_toks = None, []

    for tok, lab in zip(tokens, labels):
        if lab == "O" or "-" not in lab:
            flush()
            continue
        prefix, tag = lab.split("-", 1)
        if prefix == "B" or tag != cur_tag:
            flush()
            cur_tag, cur_toks = tag, [tok]
        else:  # I- continuation of same tag
            cur_toks.append(tok)
    flush()
    return spans


def load_corpus(parquet_path: str, n: int, rng: random.Random) -> list[dict]:
    table = pq.read_table(parquet_path, columns=["raw", "tokens", "labels", "country"])
    total = table.num_rows
    # Random row indices, then keep only multi-component addresses until we hit n.
    order = list(range(total))
    rng.shuffle(order)
    raw_col = table.column("raw")
    tok_col = table.column("tokens")
    lab_col = table.column("labels")
    cc_col = table.column("country")
    out: list[dict] = []
    for idx in order:
        if len(out) >= n:
            break
        tokens = tok_col[idx].as_py()
        labels = lab_col[idx].as_py()
        gold = reconstruct_spans(tokens, labels)
        distinct_tags = {t for t, _ in gold}
        if len(distinct_tags) < 2:
            continue  # bare admin-name row — skip, see module docstring
        out.append(
            {
                "raw": raw_col[idx].as_py(),
                "gold": gold,
                "country": cc_col[idx].as_py(),
                "source": "corpus",
                "partial": False,
            }
        )
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--corpus", required=True, help="training-corpus parquet (the model's training version)")
    ap.add_argument("--out", default=str(REPO / "data/eval/calibration/calibration-set.jsonl"))
    ap.add_argument("--oa-us", type=int, default=2000)
    ap.add_argument("--oa-fr", type=int, default=1000)
    ap.add_argument("--oa-de", type=int, default=500)
    ap.add_argument("--oa-nl", type=int, default=500)
    ap.add_argument("--corpus-n", type=int, default=4000)
    ap.add_argument("--seed", type=int, default=20260607)
    args = ap.parse_args()

    rng = random.Random(args.seed)
    oa = (
        load_oa("US", args.oa_us, rng)
        + load_oa("FR", args.oa_fr, rng)
        + load_oa("DE", args.oa_de, rng)
        + load_oa("NL", args.oa_nl, rng)
    )
    corpus = load_corpus(args.corpus, args.corpus_n, rng)
    rows = oa + corpus
    rng.shuffle(rows)

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")

    by_country: dict[str, int] = {}
    for r in rows:
        by_country[r["country"]] = by_country.get(r["country"], 0) + 1
    print(f"wrote {len(rows)} rows → {out_path}")
    print(f"  OA={len(oa)}  corpus={len(corpus)}")
    print(f"  by country: {dict(sorted(by_country.items(), key=lambda kv: -kv[1]))}")


if __name__ == "__main__":
    main()
