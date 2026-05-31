#!/usr/bin/env python3
"""summarize-arenas.py — three-bucket capability table from external-arenas.sh output.

Reads the per-arena `*.results.json` sidecars written by harness-v0-neural and
prints the neural-only / both-pass / v0-only / both-fail buckets per arena. For
the postal-standards arena it also joins back to the source JSONL (on `input`)
to break the buckets down by edge_class — the dimension the harness sidecar
drops.

Usage: summarize-arenas.py <out-dir> <postal-cases.jsonl>
"""
import json
import sys
from collections import defaultdict


def buckets(results):
    n = len(results)
    both = sum(1 for r in results if r["v0_pass"] and r["neural_pass"])
    only_n = sum(1 for r in results if not r["v0_pass"] and r["neural_pass"])
    only_v0 = sum(1 for r in results if r["v0_pass"] and not r["neural_pass"])
    neither = sum(1 for r in results if not r["v0_pass"] and not r["neural_pass"])
    tree_ok = sum(1 for r in results if r.get("neural_tree_valid"))
    return n, both, only_n, only_v0, neither, tree_ok


def pct(x, n):
    return f"{100*x/n:.0f}%" if n else "—"


def main():
    out_dir, postal_src = sys.argv[1], sys.argv[2]
    arenas = ["libpostal", "perturb", "postal"]

    print("| arena | n | v0 | neural | both | neural-only | v0-only | both-fail | tree-valid |")
    print("| --- | --: | --: | --: | --: | --: | --: | --: | --: |")
    loaded = {}
    for a in arenas:
        try:
            res = json.load(open(f"{out_dir}/{a}.results.json"))
        except FileNotFoundError:
            print(f"| {a} | (no results) |")
            continue
        loaded[a] = res
        n, both, only_n, only_v0, neither, tree_ok = buckets(res)
        v0 = sum(1 for r in res if r["v0_pass"])
        ne = sum(1 for r in res if r["neural_pass"])
        print(f"| {a} | {n} | {pct(v0,n)} | {pct(ne,n)} | {pct(both,n)} "
              f"| {pct(only_n,n)} | {pct(only_v0,n)} | {pct(neither,n)} | {pct(tree_ok,n)} |")

    # postal edge-class breakdown (join on input)
    if "postal" in loaded:
        ec = {}
        for line in open(postal_src):
            row = json.loads(line)
            ec[row["input"]] = row.get("edge_class", "?")
        by = defaultdict(list)
        for r in loaded["postal"]:
            by[ec.get(r["input"], "?")].append(r)
        print("\n### postal arena by edge_class")
        print("| edge_class | n | v0 | neural | both | neural-only | v0-only |")
        print("| --- | --: | --: | --: | --: | --: | --: |")
        for cls in sorted(by):
            res = by[cls]
            n, both, only_n, only_v0, _, _ = buckets(res)
            v0 = sum(1 for r in res if r["v0_pass"])
            ne = sum(1 for r in res if r["neural_pass"])
            print(f"| {cls} | {n} | {pct(v0,n)} | {pct(ne,n)} | {pct(both,n)} "
                  f"| {pct(only_n,n)} | {pct(only_v0,n)} |")


if __name__ == "__main__":
    main()
