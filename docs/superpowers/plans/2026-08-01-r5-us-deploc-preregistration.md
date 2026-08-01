# R5 — dependent_locality aliveness outside GB, and the US instance

Hierarchy campaign R5, opened 2026-08-01 at the operator's priority. Two questions the campaign
has been carrying as an assumption since the placetype-evidence doc was written:

1. Is `dependent_locality` **contextually dead** outside GB/NZ, as the doc asserts?
2. Is there a **per-country suppression** that would have to be lifted before a US instance works?

## Both answers are in, and both overturn the doc

**There is no per-country suppression anywhere in the runtime.** A full read of the conventions,
decoder, resolver, normalize, kind-classifier, phrase-grouper and geocode paths finds exactly one
hard emission mask (`-1e9`) — FR `street_suffix` — and `dependent_locality` appears in no
`forbiddenTags` row in either the TS table or its Python training mirror. `componentsSupported`
omits the tag for en-US, but nothing reads that field to mask emissions; its only consumer
validates the policy registry. The en-US omission is documentation, not enforcement.

**The tag is dead in the MODEL, and dead uniformly — not per-country.** Raw pre-prior logits
(`parseWithLogits`) put `B-dependent_locality` at rank 11–15 of 25 everywhere, including the GB
cases that parse correctly today:

| case         | locale | raw B-dependent_locality | top raw label  |
| ------------ | ------ | ------------------------ | -------------- |
| "Shoreditch" | en-GB  | 0.14% (rank 14)          | locality 31.3% |
| "Nine Elms"  | en-GB  | 0.13% (rank 15)          | locality 23.4% |
| "Astoria"    | en-US  | 0.74% (rank 13)          | street 15.7%   |
| "Park Slope" | en-US  | 0.65% (rank 14)          | locality 17.1% |
| "Manhattan"  | en-US  | 0.18% (rank 11)          | locality 91.9% |

US surfaces carry MORE raw dependent-locality mass than the GB ones that work. The shipped GB
behaviour is not the model preferring the tag — it is the pair index at δ=10 clearing a deficit the
en-GB model card already measured as "large but UNIFORM (~7.0 logits mean)". The origin is a
training-side class weight of 0.3 on `B/I-dependent_locality` carried from v0.5.1 through v0.8.0
("penalize hallucination of rare tags"), since corrected to 1.0 but not retrained into the shipped
lineage.

**Therefore the US instance was never gated on aliveness or on conventions. It was gated on the
artifact.** Confirmed end-to-end: a US pair index built from WOF (49,033 pairs; boroughs AND
neighbourhoods, with `borough` admitted as a parent placetype because WOF parents US
neighbourhoods to the locality) dropped beside the en-US weights flips all three probes:

| input                                                     | before                                                 | after                                                   |
| --------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------- |
| `31-01 Ditmars Blvd, Astoria, Queens, New York, NY 11105` | locality=Queens, venue=Astoria, **"New York" dropped** | dependent_locality="Astoria, Queens", locality=New York |
| `350 5th Ave, Manhattan, New York, NY 10118`              | locality=Manhattan, **"New York" dropped**             | dependent_locality=Manhattan, locality=New York         |
| `123 Main St, Park Slope, Brooklyn, NY 11215`             | locality=Park Slope, **"Brooklyn" dropped**            | dependent_locality=Park Slope, locality=Brooklyn        |

Note the silent information loss in the "before" column: the second admin level was not mislabeled,
it was **discarded**. That is a live US recall defect today, independent of any tag question.

## What is NOT yet established — the pre-registered bars

The three positives above are hand-picked. A 49,033-entry US index is a far larger ambiguity
surface than GB's curated set, and US neighbourhood surfaces are heavily homonymous with street and
venue words ("Park Slope", "Midtown", "Riverside", "Fairview"). Nothing ships until:

- **B-R5.1 (no gauntlet regression).** Full gauntlet, graded through per-country overlays
  (`caseCountry` — a base-only harness reproduces the 2026-08-01 instrument artifact), with the US
  index present vs absent. Bar: **zero newly-failing gated cases.**
- **B-R5.2 (venue-confound floor).** A held-out US confound board — neighbourhood surfaces opening
  venue names, the law-1 class R4b boarded for London. Bar: **≤2% dependent-locality false
  positives**, the shipped GB floor.
- **B-R5.3 (positive side).** A held-out US board of real borough/neighbourhood addresses, graded
  for dependent-locality emission AND correct locality assignment. Bar: **≥70% tag-correct**, the
  order the GB δ-sweep cleared.
- **D-R5.4 (disclosure).** The browser path's `detectPairIndexCountry` falls back to `us` for any
  bare Latin query with no postcode — so shipping a US index means unlabeled queries take US pair
  bias by default, where today they take none. Measure and report what that does to the GB and
  bare-name boards; it is a packaging consequence, not a bug, but it must be stated before ship.

Failing B-R5.1 or B-R5.2 stops the ship regardless of how good B-R5.3 looks.
