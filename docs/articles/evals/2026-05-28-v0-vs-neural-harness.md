---
sidebar_position: 36
title: "2026-05-28 v0-vs-Neural harness — honest assessment"
---

# v0-vs-Neural harness — 2026-05-28

The neural parser has never been measured against the legacy rule-based pipeline's hand-tuned
acceptance criteria. The 4561-entry golden set at `data/eval/golden/v0.1.2/` measures the
neural on what it was trained for; the 376 assertions in `mailwoman/test/*.test.ts` measure
the rule-based parser on what it was hand-tuned for. This eval bridges the two.

Per [DeepSeek consult turn 6](2026-05-28-night-2-postmortem.md): without this harness,
v0.6.2's corpus augmentation is "try something and hope." With it, augmentation becomes
"fix the specific assertions that fail."

## Setup

- **Harness:** `scripts/harness-v0-neural.ts` extracts every `assert(input, ...expected)` call
  from `mailwoman/test/*.test.ts` via TypeScript AST (376 assertions across 30 files spanning
  20+ locales), runs each input through BOTH `createAddressParser()` (v0 rule-based) and
  `NeuralAddressClassifier` (v0.6.0 + admin FST + morphology FST), and reports per-file /
  per-locale pass rates plus a JSON sidecar for downstream clustering.
- **Model:** v0.6.0 default (`model-v060-step-100000-int8.onnx`)
- **Admin FST:** `fst-en-us.bin`
- **Morphology FST:** built in-process from libpostal `street_types.txt` dictionaries
  (1,707 canonicals / 3,763 variants after length-3 filter)
- **Comparison semantics:**
  - **v0:** vitest `toEqual` strict deep-equality, position-by-position against ranked solutions
    (matches the existing test semantics — pass only if every expected solution deep-equals
    `solutions[i].classifications`).
  - **Neural:** flatten `AddressTree` to `Map<ComponentTag, string>`, fold neural-only tags
    (`street_prefix` + `street` + `street_suffix` → `street`; `intersection_a` + `intersection_b`
    → `street` as two values), then check if any expected solution matches the resulting
    record (substring containment in either direction allowed).

## Result

| Parser | Pass | Rate |
|---|---|---|
| v0 (rule-based) | 376 | **100.0%** |
| Neural | 54 | **14.4%** |

| Category | Count | Rate |
|---|---|---|
| Both pass | 54 | 14.4% |
| v0 only | **322** | **85.6%** |
| Neural only | 0 | 0.0% |
| Both fail | 0 | 0.0% |

**Zero neural-only wins.** Every assertion the neural passes is also passed by v0. The
rule-based pipeline strictly dominates the neural pipeline on its own test suite.

## Per-file breakdown

| File | Total | Neural % | Comment |
|---|---|---|---|
| address.usa.test.ts | 73 | 23% | Heaviest training distribution; still 56/73 missing |
| intersection.test.ts | 65 | **0%** | Total failure mode; `Main St & 5th Ave`-style inputs |
| functional.test.ts | 34 | 3% | Cross-cutting cases |
| address.fra.test.ts | 33 | 24% | Some French in training |
| address.nld.test.ts | 22 | 9% | NL compact addresses largely unhandled |
| address.nzd.test.ts | 22 | **0%** | NZ format |
| addressit.usa.test.ts | 21 | **81%** | Autocomplete-style — best performer |
| address.deu.test.ts | 17 | **0%** | German format entirely missed |
| place.fra.test.ts | 13 | **0%** | French place lookups |
| addressit.aus.test.ts | 11 | 64% | Australian autocomplete |
| address.aus.test.ts | 9 | **0%** | Australian unit notation (`Unit 12/345`) |
| address.nor.test.ts | 9 | **0%** | Norwegian |
| address.prt.test.ts | 8 | **0%** | Portuguese |
| address.pol.test.ts | 6 | **0%** | Polish |
| venue.usa.test.ts | 6 | **0%** | Venue-only inputs |
| address.rom.test.ts | 5 | 20% | Romanian |
| address.swe.test.ts | 4 | **0%** | Swedish |
| compound_street.test.ts | 4 | **0%** | Compound street tests |
| address.cze.test.ts | 3 | **0%** | Czech |
| address.gbr.test.ts | 3 | **0%** | UK format |
| (other locales) | 1-2 each | **0%** | bra, esp, hrv, ind, svk, transit |
| libpostal.test.ts | 1 | 100% | Single passing fixture |

## Failure clusters

The 322 v0-only-passes split into four structural categories:

### 1. Tokenization issues with non-ASCII

Neural tokenizer + BIO decoder garbles multi-byte characters. Examples:

- `Korunní 810, Praha` → neural: `{locality: ["Korunn"], region: ["ha"]}` — `ní` is split mid-character
- `Rua Raul Leite Magalhães, 65, Tapiraí - SP, 18180-000, Brazil` → neural: `{street: ["es"], region: ["zil"], venue: ["Rua Raul Leite Magalh"]}` — Portuguese diacritics destroy span boundaries

This is a tokenizer/encoder issue, not a schema issue. The model can't recover when SentencePiece pieces don't reassemble to the original characters.

### 2. Schema gap: `unit_designator`

v0 has both `unit` and `unit_designator` — for `Unit 12/345 Main St`, expected is
`{unit_designator: ["Unit"], unit: ["12"], house_number: ["345"], street: ["Main St"]}`. The
neural schema only has `unit`. Every Australian unit-notation test fails on this gap alone:

- `Apartment 12/345 Main St` → expected `unit_designator: ["Apartment"]` but neural has no tag for it
- `U 12 345 Main St` → same problem with `U`
- `Lot 12/345 Illawarra Road...` → 9 of 22 NLD/AUS tests fail on this single missing tag

This is solvable by adding `unit_designator` to the Stage 3 schema (and the training corpus's
adapters), but it's a schema change requiring retraining.

### 3. House-number / street boundary

The neural parser keeps reading street and house_number as one span. German examples:

- `Am Nordkanal 11, 47877 Willich` → expected `street: "Am Nordkanal"` + `house_number: "11"`; neural: `street: "Am Nordkanal 11"`
- `Am Falkpl. 5, 10437 Berlin` → expected `street: "Am Falkpl."`; neural: `street: "Am Falkpl"` (period dropped) — close but not equal under strict comparison

The model never saw enough German addresses to learn the prepend-house-number pattern. v0's
HouseNumberClassifier hard-codes the heuristic; the neural has to learn it from data.

### 4. Intersections (0/65)

Every intersection test fails. `Main St & 5th Ave` → expected
`{street: ["Main St", "5th Ave"]}` (two street values); neural produces single-street
output or routes one side into a non-street tag. This is the failure mode the falsehoods
doc flagged. v0 has a dedicated `IntersectionClassifier` + `CompositeIntersectionClassifier`;
the neural has `intersection_a/b` BIO tags but the training data appears to undersample
intersections relative to v0's hand-tuned coverage.

## What this means for v0.6.2

This is the "honest assessment" the postmortem called for. The implications:

1. **Locale coverage is the dominant gap.** US, FR, and a slice of AUS are in distribution;
   everything else is structurally untaught. v0.6.2's corpus augmentation has to expand
   beyond US-only synth-street.
2. **Schema additions are needed before retraining helps Aus/UK unit notation.** The
   `unit_designator` gap can't be papered over by training-data tweaks.
3. **Intersections need targeted corpus work.** v0.6.0's synth-street shard taught street
   decomposition but didn't include intersection patterns at all.
4. **Tokenizer is suspect for non-ASCII.** Czech / Portuguese / German diacritics are
   destroying span boundaries. Needs investigation independent of the corpus path.
5. **Strict equality might be the wrong bar for the neural parser.** v0's tests assert exact
   structural equality including punctuation. The neural pipeline currently doesn't preserve
   token-level punctuation. A looser equivalence (`Am Falkpl.` ≈ `Am Falkpl`) would change
   the picture for cluster #3 specifically; whether that looser bar is acceptable is a
   product decision.

## Reproducing

```bash
node --experimental-strip-types scripts/harness-v0-neural.ts \
  --tests mailwoman/test \
  --model /mnt/playpen/mailwoman-data/models/quantized/model-v060-step-100000-int8.onnx \
  --tokenizer /mnt/playpen/mailwoman-data/models/tokenizer/v0.6.0-a0/tokenizer.model \
  --model-card neural-weights-en-us/model-card.json \
  --admin-fst /mnt/playpen/mailwoman-data/wof/fst-per-locale/fst-en-us.bin \
  --out-json /tmp/harness-full.json \
  > /tmp/harness-full-report.md
```

Total runtime: ~5 seconds for 376 assertions.

## See also

- [Street-supplement architecture](../concepts/street-supplement-architecture.md) — the design context
- [Layer 1 morphology FST eval](2026-05-28-layer-1-morphology-fst.md) — preceding eval that
  established the decoder-only fix is insufficient
- [Falsehoods about street names](../understanding/why-its-hard/falsehoods-streets.md) — the
  edge cases the harness's falsehoods row source captures
- [2026-05-28 night-2 postmortem](2026-05-28-night-2-postmortem.md) — postmortem that triggered
  this assessment
