# v7 rules-excision — state of play + open decisions (2026-07-15 night)

Handoff for a fresh context. Written after a working session that produced one shipped release, a
diagnosis of the v7 blocker, and a set of hypotheses — some of which were walked back under review.
Confidence is marked per claim: **[measured]**, **[concluded]**, **[hypothesis]**, **[retracted]**.

## Objective, stated precisely

Ship v7.0.0 = **delete** the legacy rules parser. "Delete" qualifies as all of:

1. No production surface calls `createAddressParser` — the three sites (`/v1/parse`, libpostal
   `/parse`, nominatim streetParts) run neural only.
2. The rules classifier code is removed + sealed — `@mailwoman/classifiers`' rule parser and its
   `context`/`Graph`/`permutate` machinery deleted, git tag `legacy-rules-final`, npm package
   deprecated/archived.
3. Shared contracts rehomed to survive the deletion — `Classification.ts` → `core/types`; the
   `tokenization/context → core/solver` edge split (`Span`/normalizer/`split` stay).
4. The rules parser's hand-written gold (the parity corpus) rescued to neural eval fixtures.
5. NOT deleted: the libpostal dictionary data + the generic tokenization utilities.

The swaps for (1) are already built on `origin/hold/v1-parse-neural-gate-blocked`. Deletion is gated
on **the three swapped surfaces producing acceptable output**, not on the model reaching a specific
parity score. That distinction is the crux of the open decisions below.

## What shipped tonight (done + verified)

- **v6.3.0 = v264 country-softguard** live on npm / HF / R2 / GitHub, md5 `3e534072` agreeing across
  all backends. It softens v263's homograph guard (`country_ambiguous_scale` 1.0→0.5, baked into the
  ONNX). Strictly dominates v263 on country, no trade. [measured]
- **#1087 closed** — drop-in `GET /` banner + README sweep.
- Two eval docs de-slopped.

None of the v7 work below has shipped or merged.

## v7 blocker, characterized

The neural model misses the plan-2 parity floors on the rescued parity corpus (321 live fixtures):
**street 0.54 vs 0.90, house_number 0.77 vs 0.97, postcode 0.99 PASS**. [measured]

This is an old plateau, not a regression: v264 ≈ v257 (street 0.543 vs 0.536), so the span-boundary
head and the country channel did not erode fragment parsing. [measured]

Where it breaks is one joint: the **street ↔ house-number boundary**. Coarse geography is fine
(postcode ~98.6% resolve; locality/region/country land correctly). About 60–70% of failures are the
number landing on the wrong side of the street, splitting, or dropping. Sampled class shares (85-row
`--failing 50` cut): empty/not-emitted 40%, boundary-digit 20%, boundary-span 19%, accent 15%, unit
4%. [measured, small sample]

## What the failing addresses have in common

The troubled inputs share a house number that is not a US-style leading integer (trailing/European
order, multi-digit that the tokenizer shatters, alphanumeric like `16a`, route-embedded like `9600
Interstate 35`, or unit-compound `U12/345`), often on a street token that resists clean segmentation
(diacritic-heavy, or led by a lowercase generic like `aleja`/`Rue`), amplified by thin context.
[concluded]

Two claims I made and then corrected under review — **do not carry these forward as findings**:

- **"The model overfit the US template" — [retracted].** The evidence cuts against it. The non-US
  forms were well-fed, several above US weight (`gnaf` AU 6.0, `synth-german` 6.0,
  `synth-fr-admin-split` 6.0 vs `tiger` US 4.0), and the targeted bare-street shards ride at 12.0.
  Under-exposure would have been fixed by that; it wasn't. Part of the failure (per-digit number
  fragmentation) is country-independent, and US highway/rural addresses fail too. The defensible read
  is **structural difficulty / capacity under flat BIO**, which is what the #727 runbook already
  concluded — not a frequency/overfit effect. I have no evidence for the frequency version.
- **"Diacritics are a new problem" — [corrected to: visibility, not regression].** Prior splice work
  (v5.1.0 CZ/PL/SK/SI, v5.2.0 Nordic, v5.9.0 FR) fixed diacritic fragmentation, but measured on
  **resolve / wrong-city**. Tonight's misses are **street-tag surface exactness** on the parity
  corpus, a metric that only exists since 2026-07-13. The city can resolve while the street surface
  reads `K jovská`. Plus PT and RO were never spliced (RO `ț` byte-falls-back — confirmed by probe).
  So it is old signal newly measured + two coverage gaps, not the covered locales regressing. Caveat:
  the "prior work measured resolve, not street-surface" split is inferred from release notes, not
  re-run — it is worth confirming by re-scoring one covered locale (CZ) on both metrics.

## Proxy vs goal (the useful part of tonight)

The plan-2 floors are **parse-tag byte parity** — a proxy plan 2 chose for "acceptable." The drop-in
surfaces serve a geocode, so the question that decides deletion is whether the swapped surfaces
geocode acceptably, not whether the tags match byte-for-byte.

Measured coordinate parity (resolve each parity fixture through the same WOF resolver with both the
rules tree and the v264 tree): [measured]

- When the neural street parse is correct → **98.6% within 1 km** of the rules geocode, median 0 km.
  Benign parse-tag differences (`Königsallee Düsseldorf` as one span) resolve to the same place.
- When the neural parse fails → a hard tail: **40% of the street-failing subset move >25 km**, often
  to a country centroid or wrong state (`California` → Maryland; bare `6000, NSW, Australia` → the AU
  country centroid). Concentrated on bare-fragment / US-highway / bare-state-name classes.

Caveats on that experiment: it measures neural-vs-rules divergence, not accuracy against ground truth
(the corpus has no gold coords, and rules is sometimes the wrong one); the corpus is deliberately
fragment/edge-case-heavy, so the tail is smaller on real drop-in traffic than the 21% seen here.

## What I built, and where it conflicts with the spec

- **Resolution-plausibility guard** — `resolver/plausibility.ts`, `isImplausibleResolution(tree)`,
  6 tests passing, committed on branch `feat/v7-hybrid-swap-gate` (NOT merged). Trips when a tree
  resolves no finer than a country centroid. Reusable for any gate direction. [done]
- I then drafted a **hybrid swap gate** (route `structured_address`→neural, everything else→rules
  fallback, + the guard) and measured it bounds the garbage tail to ~3/321 (0.9%) with zero
  false-positive fallbacks. **But this keeps rules as a fallback = demote, not delete.** The held
  `/v1/parse` swap's own docstring says its design is "no rules fallback (the legacy-excision's
  point)." So the hybrid **contradicts the option-A delete spec**. This is a spec-level decision that
  is yours, not mine, and I stopped before wiring it.

## Levers considered and NOT committed to

- **digit-atomicity tokenizer splice.** Probe confirmed the _cause_: the tokenizer splits multi-digit
  numbers per-digit (`810`→`▁8 1 0`), so the boundary can fall inside a number. [measured] But I have
  **no evidence the fix works** — `16a` tokenizes atomically (`▁16`) and still absorbs into the
  street, and the cited literature (GLiNER, Filtered Semi-Markov CRF, Yin'23) points at structured
  span prediction, not digit-atomicity. Launching a retrain on the cause alone would be
  over-commitment on self-generated confirmation. [hypothesis, unvalidated]
- **#727 stage-2 (FSemi-CRF span head).** The runbook's confirmed next model arc for the boundary
  class; stage-1 (aux head) plateaued at 5→2 flips. Explicitly a multi-night architecture build (new
  export path, #378 SLO, capability rework) — a fresh dedicated workstream, not a tail-end launch.
- **29M shard campaign.** Deprioritized — the v250→v257 campaign already threw 12.0-weight targeted
  shards and plateaued; more re-plateaus. [concluded]

## Open decisions for you (in priority order)

1. **What is the acceptance criterion for deleting rules?** The parse-tag floor is a proxy that may be
   unreachable at 29M. Candidates: (a) hold the 0.90/0.97 parse-tag floors and invest in the model
   until it clears them; (b) re-gate on coordinate acceptability of the swapped surfaces; (c) accept
   a thin rules fallback for the classes the model can't carry (demote, softens "delete"); (d) some
   mix. Everything else waits on this.
2. **Is demote-with-fallback acceptable, or is delete non-negotiable?** If delete is firm, the hybrid
   gate is off the table and the path is model investment (FSemi-CRF / PT-RO splice / digit work) to
   carry the failing classes outright.
3. **If we invest in the model, which lever first** — FSemi-CRF (literature-backed, multi-night), a
   PT/RO diacritic splice (fills a confirmed coverage gap), or a digit-atomicity probe (validate the
   fix before the retrain)?

## Artifacts + state

- Branch `feat/v7-hybrid-swap-gate` (off main): the plausibility guard + tests, committed, not pushed.
- Held swaps: `origin/hold/v1-parse-neural-gate-blocked` (T1 libpostal / T2 /v1/parse / T4 nominatim),
  blocked by `mailwoman/test/v1-parse-gate.test.ts` (the 0.90/0.97 parse-tag floors).
- Diagnosis write-up: `docs/articles/evals/2026-07-15-v7-parity-floor-diagnosis.md`.
- Probes (repro): `scratchpad/{coord-parity,ctx-probe2,tok-probe,tok-digits,parity-split}.mjs`;
  package-shaped v264 cache at `scratchpad/v264-cache`.
- Memory: `project-v7-legacy-excision-arc` (updated with tonight's night-2 entry).

## Cheap things to verify next (before any GPU)

- Partition the 122 street failures by number position (leading/trailing/none) and form
  (plain/multi-digit/alphanumeric); see whether the failure rate tracks those, to test the
  "diverges from the number template" read instead of eyeballing it.
- Re-score CZ on both resolve-match and parity street-tag to confirm the diacritic "visibility not
  regression" split.
- If digit-atomicity stays on the table, an independent read (DeepSeek consult + the cited papers) on
  digit-splice vs FSemi-CRF before committing a retrain.
