"""B3 — build the Norwegian digit-ownership board from the NO boundary tuples (Kartverket-derived).

WHY THIS BOARD EXISTS. `#901` measured a 30% residual on Norwegian street-led forms, diagnosed it as
order-sensitive decode, and built `synth-no-street-led` at source weight 12.0 to fix it. The YAML
Norway problem (`NO:` -> boolean false) meant that shard never contributed a row: NO went from 12,000
shard rows to 0 in every training run since v1.9.0. The fix is #1145. This is the instrument that
grades it — and the reason we can grade it honestly is that SHIPPED v310 has never seen a single
Norwegian address, so the baseline is a true zero-knowledge arm.

THE SPLIT. `no-street-led.ts` has no `--exclude-surfaces` (fr-fragment has it and throws without it),
so the shard currently trains on all 10,697 surfaces. A board built from the same tuples would
measure memorization. This reserves surfaces for the board; the recipe is changed to require the
exclusion. Source-disjoint by normalized street SURFACE, never by record row — row-disjoint leaks the
surface across the boundary.

CLASSES. Digit ownership is the question: which tag owns a digit-bearing token?

  street-led-hn      "Tangavegen 40, 5620 Torvikbygd"   the #901 30%-residual form
  city-first-hn      "Torvikbygd, 5620, Tangavegen 40"
  pc-first-hn        "5620 Torvikbygd, Tangavegen 40"   the 7% floor
  bare-street-hn     "Tangavegen 40"                    no postcode present to compete for the digit
  slash-hn           "Ovrabo 124/1"                     NO cadastral gnr/bnr — ONE house_number
  NEGATIVE: bare-pc  "5620"                             must STILL emit postcode

THE NEGATIVE CLASS IS THE POINT. Every positive class rewards "call the digit a house_number". A
model can ace all five by never emitting postcode again. `bare-pc` is the guard that makes the board
score a distinction rather than a flipped default — the same role `bare-locality` plays on the FR
fragment board, where it held at 0.980 and proved v310 learned rather than swapped.

SLASH HAZARD, stated because it will bite: NO `124/1` is ONE component (cadastral gnr/bnr) while AU
`12/345` is TWO (unit 12 + house_number 345). Identical surface shape, opposite correct answers. Do
not let a future intra-word-split shard (B5) generalize the AU rule over Norwegian numbers.
"""

import json
import random
import re
import unicodedata
from pathlib import Path

TUPLES = Path("/mnt/playpen/mailwoman-data/corpus/tuples/no-boundary-tuples.jsonl")
OUT_FIXTURES = Path("mailwoman/eval-harness/fixtures/no-digits.jsonl")
OUT_SURFACES = Path("mailwoman/eval-harness/fixtures/no-digits.surfaces.txt")
PER_CLASS = 400
SEED = 42


def norm_surface(s: str) -> str:
    """The surface key. Must match the recipe's normalizer or the split silently leaks."""
    s = unicodedata.normalize("NFC", s).strip().lower()

    return re.sub(r"\s+", " ", s)


def title_no(s: str) -> str:
    """Kartverket ships localities ALL-CAPS (HELLVIK). Real input is title-case, and #690 established
    that all-caps is OOD for this model — leaving it would measure the casing defect instead."""
    return " ".join(w.capitalize() for w in s.split())


rows = [json.loads(line) for line in TUPLES.open() if line.strip()]
print(f"tuples: {len(rows):,}")

# A slash number is a DIFFERENT class, not noise — partition rather than filter.
plain = [t for t in rows if t.get("street") and t.get("number") and t.get("postcode") and t.get("locality")]
slash = [t for t in plain if "/" in str(t["number"])]
nonslash = [t for t in plain if "/" not in str(t["number"])]
print(f"  usable: {len(plain):,}   slash-number: {len(slash):,}   plain-number: {len(nonslash):,}")

rng = random.Random(SEED)
rng.shuffle(nonslash)
rng.shuffle(slash)

# Reserve surfaces for the board BEFORE sampling classes, so every class draws from the reserved
# pool and the exclusion list covers all of them.
need = PER_CLASS * 4 + min(PER_CLASS, len(slash))
reserved_pool = nonslash[: PER_CLASS * 4]
reserved_slash = slash[:PER_CLASS]

fixtures = []
surfaces = set()


def emit(klass, inp, expect, surface, expect_no_hn=False):
    fixtures.append(
        {
            "id": f"no-{klass}-{len(fixtures):04d}",
            "klass": klass,
            "input": inp,
            "expect": expect,
            **({"expect_no_house_number": True} if expect_no_hn else {}),
            "surface": norm_surface(surface) if surface else None,
            "source": "kartverket-derived (no-boundary-tuples)",
        }
    )
    if surface:
        surfaces.add(norm_surface(surface))


for i, t in enumerate(reserved_pool):
    st, city, num, pc = t["street"].strip(), title_no(t["locality"].strip()), str(t["number"]).strip(), str(t["postcode"]).strip()
    klass = ["street-led-hn", "city-first-hn", "pc-first-hn", "bare-street-hn"][i % 4]
    if klass == "street-led-hn":
        emit(klass, f"{st} {num}, {pc} {city}", {"street": [st], "house_number": [num], "postcode": [pc], "locality": [city]}, st)
    elif klass == "city-first-hn":
        emit(klass, f"{city}, {pc}, {st} {num}", {"street": [st], "house_number": [num], "postcode": [pc], "locality": [city]}, st)
    elif klass == "pc-first-hn":
        emit(klass, f"{pc} {city}, {st} {num}", {"street": [st], "house_number": [num], "postcode": [pc], "locality": [city]}, st)
    else:
        # No postcode in the row at all: nothing competes for the digit. If the model STILL says
        # postcode here, the defect is not a postcode-vs-house_number competition.
        emit(klass, f"{st} {num}", {"street": [st], "house_number": [num]}, st)

for t in reserved_slash:
    st, num = t["street"].strip(), str(t["number"]).strip()
    emit("slash-hn", f"{st} {num}", {"street": [st], "house_number": [num]}, st)

# THE NEGATIVE CLASS. Bare postcodes, no street, no number. Must still read postcode.
seen_pc = set()
for t in rows:
    pc = str(t.get("postcode") or "").strip()
    if pc and pc not in seen_pc:
        seen_pc.add(pc)
        emit("bare-pc", pc, {"postcode": [pc]}, None, expect_no_hn=True)
    if len(seen_pc) >= PER_CLASS:
        break

OUT_FIXTURES.parent.mkdir(parents=True, exist_ok=True)
with OUT_FIXTURES.open("w") as f:
    for fx in fixtures:
        f.write(json.dumps(fx, ensure_ascii=False) + "\n")

with OUT_SURFACES.open("w") as f:
    f.write("# Street surfaces RESERVED for the NO digit-ownership board (no-digits.jsonl).\n")
    f.write("# `no-street-led` MUST exclude these (--exclude-surfaces) or the shard trains on its\n")
    f.write("# own eval set. Source-disjoint by normalized street SURFACE, never by record row.\n")
    for s in sorted(surfaces):
        f.write(s + "\n")

from collections import Counter

counts = Counter(fx["klass"] for fx in fixtures)
print(f"\nwrote {len(fixtures):,} fixtures -> {OUT_FIXTURES}")
for k, n in counts.most_common():
    print(f"  {k:<16s} {n:>5,}")
print(f"\nreserved {len(surfaces):,} surfaces -> {OUT_SURFACES}")
