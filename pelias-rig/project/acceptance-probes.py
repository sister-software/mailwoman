"""
The §3 per-country acceptance probes: does this build ANSWER for each of the twelve countries?

Three probes per country, straight out of the preregistration:

1. a known rooftop address -> `layer: address`, under 50 m
2. an interpolation-class address (no point record) -> a point under 1 km
3. a city-only query -> a locality match, never empty

Probes 1 and 3 draw from the hash-pinned panel, which is the right source and not a leak: the panel
is exactly the set this build has to be able to answer, and §3 is a gate that runs BEFORE any
benchmark row is scored. Nothing here writes a score, chooses a threshold after seeing a result, or
re-runs a country. A country that fails is printed FAIL and, per the preregistered stop rule, gets
labeled `coverage-limited` in the report rather than quietly retried.

Probe 2 cannot come from the panel — the panel carries no `TIGER_range` or `OSM_interpolation` rows,
because a row whose truth is a surveyed point is by construction not interpolation-class. Its inputs
come from `--interpolation-probes`, a file built from the interpolation `address.db` after the build
(rows the ES point index does not contain). Without that file probe 2 is reported SKIP, never PASS.

Usage:
  python3 acceptance-probes.py [--api http://localhost:4000] [--per-country 3]
                               [--interpolation-probes probes.jsonl] [--out results.jsonl]
"""

import json
import math
import os
import sys
import urllib.parse
import urllib.request
from collections import defaultdict

API = "http://localhost:4000"
# Resolved from this file, never hardcoded: the rig is driven from a git worktree whose path changes
# per agent, and `pelias-rig/panel/` is a fixed sibling of `pelias-rig/project/` in every checkout.
PANEL = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "panel", "panel-v1.jsonl")
COUNTRIES = ["US", "FR", "DE", "GB", "AU", "NZ", "AT", "CH", "CZ", "DK", "BE", "NL"]

ROOFTOP_LIMIT_M = 50.0
INTERPOLATION_LIMIT_M = 1000.0


def haversine_m(lat1, lon1, lat2, lon2):
    r = 6371008.8
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def search(api, text, size=1):
    url = f"{api}/v1/search?" + urllib.parse.urlencode({"text": text, "size": size})
    try:
        with urllib.request.urlopen(url, timeout=30) as fh:
            return json.load(fh)
    except Exception as exc:  # a probe that errors is a probe that failed, not a crash
        return {"error": str(exc), "features": []}


def top1(response):
    features = response.get("features") or []
    if not features:
        return None
    f = features[0]
    lon, lat = f["geometry"]["coordinates"]
    return {"lat": lat, "lon": lon, "layer": f["properties"].get("layer"), "name": f["properties"].get("label")}


def arg(name, default=None):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else default


def main():
    api = arg("--api", API)
    per_country = int(arg("--per-country", "3"))
    interp_path = arg("--interpolation-probes")
    out_path = arg("--out")

    panel = [json.loads(line) for line in open(PANEL)]
    by_country = defaultdict(lambda: defaultdict(list))
    for row in panel:
        by_country[row["country"]][row["truth_type"]].append(row)

    interp = defaultdict(list)
    if interp_path:
        for line in open(interp_path):
            row = json.loads(line)
            interp[row["country"]].append(row)

    results = []

    def run(country, probe, rows, limit_m, want_layers):
        outcomes = []
        for row in rows:
            response = search(api, row["input"])
            hit = top1(response)
            if hit is None:
                outcomes.append({"input": row["input"], "verdict": "EMPTY", "distance_m": None, "layer": None})
                continue
            distance = haversine_m(row["truth_lat"], row["truth_lon"], hit["lat"], hit["lon"])
            layer_ok = want_layers is None or hit["layer"] in want_layers
            ok = layer_ok and (limit_m is None or distance <= limit_m)
            outcomes.append(
                {
                    "input": row["input"],
                    "verdict": "PASS" if ok else "FAIL",
                    "distance_m": round(distance, 1),
                    "layer": hit["layer"],
                    "label": hit["name"],
                }
            )
        verdict = "PASS" if outcomes and any(o["verdict"] == "PASS" for o in outcomes) else "FAIL"
        results.append({"country": country, "probe": probe, "verdict": verdict, "outcomes": outcomes})
        return verdict

    print(f"{'cc':<4}{'1 rooftop<50m':>16}{'2 interp<1km':>16}{'3 city-only':>14}")
    for country in COUNTRIES:
        p1 = run(country, "rooftop", by_country[country]["rooftop"][:per_country], ROOFTOP_LIMIT_M, {"address"})
        if interp[country]:
            p2 = run(country, "interpolation", interp[country][:per_country], INTERPOLATION_LIMIT_M, None)
        else:
            p2 = "SKIP"
            results.append({"country": country, "probe": "interpolation", "verdict": "SKIP", "outcomes": []})
        p3 = run(country, "city-only", by_country[country]["city-only"][:per_country], None, {"locality"})
        print(f"{country:<4}{p1:>16}{p2:>16}{p3:>14}")

    failing = sorted({r["country"] for r in results if r["verdict"] == "FAIL"})
    print("\ncoverage-limited (per the §3 stop rule — labeled, not re-run):", ", ".join(failing) or "none")

    if out_path:
        with open(out_path, "w") as fh:
            for r in results:
                fh.write(json.dumps(r) + "\n")
        print("wrote", out_path)


if __name__ == "__main__":
    main()
