#!/usr/bin/env python3
# @copyright Sister Software · @license AGPL-3.0 · @author Teffen Ellis, et al.
#
# Build the EXPANDED real-affix eval (#511): >=100 street_prefix / >=100 street_suffix instances,
# replacing gate decisions on the 32-row hand-curated set (one instance ~ 4pp — coin-flip noise,
# flagged in the 2026-06-10 DeepSeek consult). Gold splits come from NAD's NATIVE structured fields
# (St_PreDir / St_Name / St_PosTyp) — the source agency's own decomposition, NOT our codex matchers,
# so the eval cannot inherit a relabel-pass bug (no circularity). The codex preferred-abbr map is
# used only as a SURFACE transform (render "West"->"W", "Avenue"->"Ave" on half the rows); the
# split decision is never ours.
#
# Sampling: spread across NAD shard files (state diversity), dedupe by (street, locality), one row
# per street. Includes the short-street watch class (single-word name + suffix, "Main St" type).
#
# Usage: corpus-python/.venv/bin/python scripts/eval/build-affix-real-expanded.py
#   writes data/eval/external/street-affix-real-v2.jsonl

import json
import random
from pathlib import Path

SRC = Path("/mnt/playpen/mailwoman-data/corpus/sources/usgov-nad/featureserver")
OUT = Path("data/eval/external/street-affix-real-v2.jsonl")
TARGET_PREFIX = 110
TARGET_SUFFIX = 130
MAX_PER_STATE = 12

# Surface abbr maps — render-only (see header). Mirrors codex preferred abbreviations.
DIR_ABBR = {"North": "N", "South": "S", "East": "E", "West": "W",
            "Northeast": "NE", "Northwest": "NW", "Southeast": "SE", "Southwest": "SW"}
SUF_ABBR = {"Street": "St", "Avenue": "Ave", "Boulevard": "Blvd", "Drive": "Dr", "Road": "Rd",
            "Lane": "Ln", "Court": "Ct", "Circle": "Cir", "Place": "Pl", "Terrace": "Ter",
            "Parkway": "Pkwy", "Highway": "Hwy", "Trail": "Trl", "Way": "Way", "Loop": "Loop"}

rng = random.Random(511)
files = sorted(SRC.glob("oids_*.ndjson"))
rng.shuffle(files)

rows: list[dict] = []
seen: set[tuple[str, str]] = set()
state_counts: dict[str, int] = {}
n_prefix = n_suffix = 0

for f in files:
    if n_prefix >= TARGET_PREFIX and n_suffix >= TARGET_SUFFIX:
        break
    with open(f) as fh:
        for line in fh:
            if n_prefix >= TARGET_PREFIX and n_suffix >= TARGET_SUFFIX:
                break
            try:
                d = json.loads(line)
            except json.JSONDecodeError:
                continue
            # Some shards wrap fields in "attributes"; most are flat.
            a = d.get("attributes", d)
            name, suffix = a.get("St_Name"), a.get("St_PosTyp")
            prefix = a.get("St_PreDir")
            num = a.get("AddNo_Full") or a.get("Add_Number")
            city = a.get("Post_City") or a.get("Inc_Muni")
            state, zipc = a.get("State"), a.get("Zip_Code")
            if not (name and suffix and num and city and state and zipc):
                continue
            if city.lower() in ("not stated", "unknown") or a.get("St_PreTyp") or a.get("St_PosDir"):
                continue  # pre-types ("Highway 12") and post-directionals are out of scope (#511 parity)
            if city.lower().startswith("city of "):
                city = city[8:]
            key = (name.lower(), city.lower())
            if key in seen or state_counts.get(state, 0) >= MAX_PER_STATE:
                continue
            # Balance: once suffix-only quota is met, require a prefix.
            if not prefix and n_suffix >= TARGET_SUFFIX - 30:
                continue
            seen.add(key)
            state_counts[state] = state_counts.get(state, 0) + 1

            abbr = rng.random() < 0.5
            r_prefix = (DIR_ABBR.get(prefix, prefix) if abbr else prefix) if prefix else None
            r_suffix = SUF_ABBR.get(suffix, suffix) if abbr else suffix
            street_parts = [p for p in (r_prefix, name, r_suffix) if p]
            raw = f"{num} {' '.join(street_parts)}, {city}, {state} {zipc}"
            components = {"house_number": str(num), "street": name, "street_suffix": r_suffix,
                          "locality": city, "region": state, "postcode": str(zipc)}
            if r_prefix:
                components["street_prefix"] = r_prefix
                n_prefix += 1
            n_suffix += 1
            rows.append({"raw": raw, "components": components, "source": "usgov-nad-native-fields"})

rng.shuffle(rows)
OUT.write_text("".join(json.dumps(r) + "\n" for r in rows))
short = sum(1 for r in rows if " " not in r["components"]["street"])
print(f"wrote {OUT}: {len(rows)} rows · prefix instances {n_prefix} · suffix instances {n_suffix}")
print(f"states: {len(state_counts)} · single-word-name (short-street watch): {short} · abbr/full mix by seed 511")
