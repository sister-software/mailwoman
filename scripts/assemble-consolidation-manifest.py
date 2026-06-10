#!/usr/bin/env python3
"""Assemble the CONSOLIDATION corpus MANIFEST (#466, the v0-parity flag-plant).

One model carrying every proven parity lever. The corpus is a pure manifest CONCAT — no rebuild: take
the multi-locale affix overlay (v0.4.11-affix-ml = base+unit+german+deepseek+affix, #469) and append
the balanced country shard (v0.4.10-country-bal, #464). Every referenced parquet already lives on the
Modal volume, so only the manifest is new. The gazetteer anchor + train-time choreography are set in
the CONFIG (v1.0.0-consolidation.yaml), not the corpus — the clue is painted from the raw surface by
the lexicon at data-load time, so no corpus columns are needed.

Pipeline:
  python3 scripts/assemble-consolidation-manifest.py \
      --affix-base /mnt/playpen/.../v0.4.11-affix-ml/corpus-v0.4.11-affix-ml/MANIFEST.json \
      --country-source /mnt/playpen/.../v0.4.10-country-bal/corpus-v0.4.10-country-bal/MANIFEST.json \
      --new-dir /mnt/playpen/.../v0.4.12-consolidation/corpus-v0.4.12-consolidation \
      --version v0.4.12-consolidation
  # then `modal volume put` the manifest onto the mailwoman-training volume.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--affix-base", type=Path, required=True, help="multi-locale affix overlay MANIFEST.json (the base to extend)")
    ap.add_argument("--country-source", type=Path, required=True, help="balanced country MANIFEST.json (source of the synth-country train shard)")
    ap.add_argument("--new-dir", type=Path, required=True, help="local consolidation corpus dir (holds the written manifest)")
    ap.add_argument("--version", default="v0.4.12-consolidation")
    args = ap.parse_args()

    affix = json.loads(args.affix_base.read_text())
    country = json.loads(args.country_source.read_text())

    # Pull the synth-country TRAIN shard verbatim — its parquet already lives on the volume.
    ctrain = [s for s in country["shards"] if s.get("source") == "synth-country" and s["split"] == "train"]
    if len(ctrain) != 1:
        raise SystemExit(f"expected exactly 1 synth-country train shard, found {len(ctrain)}")
    ctrain = ctrain[0]

    srcs = {s.get("source") for s in affix["shards"]}
    if "synth-affix" not in srcs:
        raise SystemExit("affix-base manifest is missing synth-affix — wrong base?")
    if "synth-country" in srcs:
        raise SystemExit("affix-base manifest already carries synth-country — nothing to add")

    manifest = dict(affix)
    manifest["corpus_version"] = args.version
    manifest["overlay_base"] = affix["corpus_version"]
    manifest["note"] = (
        f"CONSOLIDATION corpus (#466): {affix['corpus_version']} shards (base+unit+german+deepseek+"
        "MULTI-LOCALE affix) referenced verbatim + the balanced country shard. Every proven parity "
        "lever in one corpus; the gazetteer anchor + choreography are config-side. po_box/cedex deferred."
    )
    manifest["shards"] = affix["shards"] + [ctrain]
    manifest["counts"] = {
        "train": affix["counts"]["train"] + ctrain["rows"],
        "val": affix["counts"]["val"],
        "test": affix["counts"]["test"],
    }
    manifest["total_rows"] = affix["total_rows"] + ctrain["rows"]

    out = args.new_dir / "MANIFEST.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(manifest, indent=1) + "\n")
    print(f"wrote {out}")
    print(f"  shards: {len(manifest['shards'])} ({len(affix['shards'])} affix-ml + 1 country)")
    print(f"  sources: {sorted(s.get('source') for s in manifest['shards'] if s.get('source'))}")
    print(f"  counts: {manifest['counts']}  total: {manifest['total_rows']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
