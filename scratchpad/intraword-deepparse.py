"""B0 arm 2 — deepparse on the intra-word control set.

The decisive question is NOT "who scores higher". It is REPRESENTATIONAL: deepparse pools each
word's subwords into one vector and emits one tag per word, so for a single whitespace word carrying
two components (`12/345` = unit 12 + house_number 345) the correct answer is not in its output space
at any confidence. This dumps its actual spans so that claim is measured rather than argued from the
architecture description.

Run inside the deepparse venv:

    cd /home/lab/Projects/deepparse && source .venv/bin/activate && \
      python /home/lab/Projects/mailwoman/scratchpad/intraword-deepparse.py
"""

import json
import warnings

warnings.filterwarnings("ignore")

from deepparse.parser import AddressParser

BASE = "/home/lab/Projects/mailwoman/scratchpad"
control = json.load(open(f"{BASE}/intraword-control.json"))

rows = []
for arm in ("benefit", "cost"):
    for r in control[arm]:
        rows.append({"arm": arm, **r})

# The designator minimal pairs — the licence test, run on their side too. If deepparse splits
# `12/345` with no designator present, the licence is ours alone. If it splits neither, the
# capability gap is representational and symmetric-in-failure but asymmetric-in-ceiling.
extra = [
    "Unit 12/345 Main St",
    "12/345 Main St",
    "Apt 12/345 Main St",
    "3/17 Bondi Rd",
    "Unit 12/345",
    "12/345",
]
for e in extra:
    rows.append({"arm": "designator-pair", "input": e, "why": "licence minimal pair", "expect": {}})

parser = AddressParser(model_type="bpemb", device="cpu", verbose=False)
parsed = parser([r["input"] for r in rows])
if not isinstance(parsed, list):
    parsed = [parsed]

out = []
for row, p in zip(rows, parsed):
    got = {}
    for token, tag in p.to_list_of_tuples():
        if tag in (None, "EOS"):
            continue
        got[tag] = f"{got[tag]} {token}" if tag in got else token
    out.append({**row, "deepparse": got})

with open(f"{BASE}/deepparse-cmp/intraword-deepparse.json", "w") as f:
    json.dump(out, f, indent=2, ensure_ascii=False)
    f.write("\n")

print(f"wrote {len(out)} rows")
for r in out:
    print(f"  [{r['arm']:<15}] {r['input']:<34} {json.dumps(r['deepparse'], ensure_ascii=False)}")
