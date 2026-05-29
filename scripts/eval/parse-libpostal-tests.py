#!/usr/bin/env python3
"""Parse libpostal's test/test_parser.c into mailwoman-schema {input, expected} cases.

libpostal (openvenues/libpostal, MIT) is a *statistical* address parser of a
different lineage than our Pelias-derived v0 — so its hand-curated adversarial
test cases are an UNBIASED cross-architecture benchmark (our own suite is a
Pelias/addressit port, so v0 scores ~100% on it tautologically).

Fetch the source first:
  curl -sL https://raw.githubusercontent.com/openvenues/libpostal/master/test/test_parser.c -o /tmp/test_parser.c
Then:
  python3 scripts/eval/parse-libpostal-tests.py /tmp/test_parser.c data/eval/external/libpostal-cases.jsonl

Run it through the harness (fair symmetric matching — see --symmetric-match):
  node --experimental-strip-types scripts/harness-v0-neural.ts \
    --tests <empty-dir> --falsehoods <dir-with-this-jsonl> \
    --model <onnx> --tokenizer <spm> --model-card <json> \
    --postcode-repair --symmetric-match --out-json /tmp/libpostal-bench.json

Tag remap (libpostal -> mailwoman): road->street, city->locality, state->region,
house->venue, suburb->dependent_locality, city_district->dependent_locality (or
locality when no city present). Unmappable libpostal tags (level/staircase/
entrance/building/metro_station/world_region/...) are DROPPED from the expected
(not scored) — so use --symmetric-match so v0 is scored on the same subset.
"""
import json
import re
import sys

REMAP = {
    "road": "street", "house_number": "house_number", "city": "locality", "state": "region",
    "postcode": "postcode", "country": "country", "unit": "unit", "po_box": "po_box",
    "house": "venue", "suburb": "dependent_locality",
}
DROP = {"level", "staircase", "entrance", "building", "metro_station", "world_region",
        "country_region", "island", "state_district", "website", "phone"}


def main() -> None:
    src_path = sys.argv[1] if len(sys.argv) > 1 else "/tmp/test_parser.c"
    out_path = sys.argv[2] if len(sys.argv) > 2 else "data/eval/external/libpostal-cases.jsonl"
    src = open(src_path).read()

    calls = re.findall(
        r'test_parse_result_equals\(\s*"((?:[^"\\]|\\.)*)"\s*,\s*\w+\s*,\s*\d+\s*,(.*?)\)\s*\)', src, re.S
    )
    cases = []
    for inp, body in calls:
        pairs = re.findall(r'\(labeled_component_t\)\{\s*"([^"]+)"\s*,\s*"((?:[^"\\]|\\.)*)"\s*\}', body)
        if not pairs:
            continue
        has_city = any(l == "city" for l, _ in pairs)
        exp: dict[str, list[str]] = {}
        for lbl, val in pairs:
            if lbl in DROP:
                continue
            tag = ("dependent_locality" if has_city else "locality") if lbl == "city_district" else REMAP.get(lbl)
            if not tag:
                continue
            exp.setdefault(tag, []).append(val.lower())
        if exp:
            cases.append({"input": inp.replace('\\"', '"'), "locale": "en-US", "expected": exp, "source": "libpostal"})

    with open(out_path, "w") as f:
        for c in cases:
            f.write(json.dumps(c) + "\n")
    print(f"wrote {len(cases)} cases to {out_path}")


if __name__ == "__main__":
    main()
