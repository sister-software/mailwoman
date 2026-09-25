# v7 rules-excision — state of play + open decisions (2026-07-15 night)

> **⚠ Superseded (2026-07-17).** All three "open decisions" below have been answered, and the
> model-investment arc this doc deferred has shipped. Do not act on this doc's open questions:
>
> - **#1 acceptance criterion →** The deletion criterion became **coordinate acceptability** (#1147), which
>   retired the 0.90/0.97 parse-tag floor.
> - **#2 demote vs delete →** **Delete** won, and the hybrid swap check was rejected. Plan 4 deleted
>   the rules parser (#1151, −9650 LOC). The seal tag is `legacy-rules-final` @ fd48c21c.
> - **#3 which model change →** All three were pursued. The **FSemi-CRF span head shipped** (v3.10.1,
>   the #727 arc, with the phase-4c name-evidence rerank now on by default), the **PT/RO diacritic
>   splice** landed (v391), and **digit-atomicity** was characterized and closed (v381 / v6.5.0).
>
> What remains for the v7.0.0 release is "plan 5": delete `@mailwoman/classifiers`, rehome or split
> the shared `core/tokenization` substrate (where Span extends Graph), land the #875 casing batch,
> remove the sdk shim, add the STAGE4 schema and retrain, and then ship. See
> `docs/superpowers/specs/2026-07-17-plan5-classifiers-substrate-deletion.md`. This doc is kept only
> as a point-in-time record.

---

This is a handoff for a fresh context. It was written after a working session that produced one
shipped release, a diagnosis of the v7 blocker, and a set of hypotheses, some of which were
withdrawn under review. Each claim is marked with its confidence: **[measured]**, **[concluded]**,
**[hypothesis]**, or **[retracted]**.

## Objective, stated precisely

v7.0.0 ships when the legacy rules parser is **deleted**. "Deleted" requires all of the following:

1. No production surface calls `createAddressParser`. The three call sites (`/v1/parse`, libpostal
   `/parse`, nominatim streetParts) run neural only.
2. The rules classifier code is removed and sealed. `@mailwoman/classifiers`' rule parser and its
   `context`/`Graph`/`permutate` implementation are deleted, the git tag `legacy-rules-final` marks
   the last version, and the npm package is deprecated or archived.
3. Shared interfaces are rehomed so they survive the deletion. `Classification.ts` moves to
   `core/types`, and the `tokenization/context → core/solver` edge is split (`Span`, the normalizer,
   and `split` stay).
4. The rules parser's hand-written gold (the parity corpus) is rescued as neural eval fixtures.
5. Kept: the libpostal dictionary data and the generic tokenization utilities.

The swaps for (1) are already built on `origin/hold/v1-parse-neural-check-blocked`. Deletion depends
on **the three swapped surfaces producing acceptable output**, and a specific parity score is
not required. That distinction is the core of the open decisions below.

## What shipped tonight (done + verified)

- **v6.3.0 (v264 country-softguard)** is live on npm, HF, R2, and GitHub, and its md5 `3e534072`
  matches across all backends. It softens v263's homograph guard (`country_ambiguous_scale`
  1.0→0.5, baked into the ONNX). It beats v263 on country without any trade-off. [measured]
- **#1087 is closed**: the drop-in `GET /` banner and a README sweep.
- Two eval docs were cleaned up.

None of the v7 work below has shipped or merged.

## v7 blocker, characterized

The neural model misses the plan-2 parity floors on the rescued parity corpus (321 live fixtures):
**street 0.54 vs 0.90, house_number 0.77 vs 0.97, postcode 0.99 PASS**. [measured]

This is an old plateau rather than a regression. v264 roughly equals v257 (street 0.543 vs 0.536),
so the span-boundary head and the country channel did not erode fragment parsing. [measured]

The failures concentrate at one point: the **street ↔ house-number boundary**. Coarse geography is
fine (postcode resolves at ~98.6%, and locality, region, and country land correctly). About 60–70%
of failures are the number landing on the wrong side of the street, splitting, or dropping.
Sampled class shares (85-row `--failing 50` reduce): empty/not-emitted 40%, boundary-digit 20%,
boundary-span 19%, accent 15%, unit 4%. [measured, small sample]

## What the failing addresses have in common

The failing inputs share a house number that is not a US-style leading integer. Examples include
trailing or European order, multi-digit numbers that the tokenizer splits apart, alphanumerics like
`16a`, route-embedded numbers like `9600 Interstate 35`, and unit compounds like `U12/345`. The
street token often resists clean segmentation, because it is diacritic-heavy or starts with a
lowercase generic like `aleja` or `Rue`. Thin context makes both problems worse. [concluded]

I made two claims and then corrected them under review. **Do not carry these forward as findings:**

- **"The model overfit the US template" — [retracted].** The evidence goes against it. The non-US
  forms were well represented, several above the US weight (`gnaf` AU 6.0, `synth-german` 6.0,
  `synth-fr-admin-split` 6.0 vs `tiger` US 4.0), and the targeted bare-street extracts are weighted at
  12.0. That exposure would have fixed an under-exposure problem, and it did not. Part of the
  failure (per-digit number fragmentation) is independent of country, and US highway and rural
  addresses fail too. The defensible reading is **structural difficulty, or a capacity limit under
  flat BIO**, which the #727 runbook already concluded. It is not a frequency or overfitting effect,
  and I have no evidence for the frequency version.
- **"Diacritics are a new problem" — [corrected to: visibility rather than regression].** Earlier
  splice work (v5.1.0 CZ/PL/SK/SI, v5.2.0 Nordic, v5.9.0 FR) fixed diacritic fragmentation, but it was
  measured on **resolve and wrong-city rates**. Tonight's misses are about **exact street-tag
  surface** on the parity corpus, a metric that has existed only since 2026-07-13. The city can
  resolve while the street surface reads `K jovská`. In addition, PT and RO were never spliced (RO
  `ț` falls back to bytes, which a probe confirmed). The misses are therefore an old signal measured
  for the first time plus two coverage gaps, and the covered locales have not regressed. Caveat: the
  claim that earlier work measured resolve rather than street surface comes from release notes and
  was not re-run. Re-scoring one covered locale (CZ) on both metrics would confirm it.

## Proxy vs goal (the useful part of tonight)

The plan-2 floors measure **parse-tag byte parity**, a proxy that plan 2 chose for "acceptable."
The drop-in surfaces serve a geocode. Deletion should therefore depend on whether the swapped
surfaces geocode acceptably, and byte-for-byte tag matches are the wrong test.

Measured coordinate parity, from resolving each parity fixture through the same WOF resolver with
both the rules tree and the v264 tree: [measured]

- When the neural street parse is correct, **98.6% land within 1 km** of the rules geocode, with a
  median of 0 km. Harmless parse-tag differences (`Königsallee Düsseldorf` as one span) resolve to
  the same place.
- When the neural parse fails, the errors are large: **40% of the street-failing subset move
  > 25 km**, often to a country centroid or the wrong state (`California` → Maryland, and bare
  > `6000, NSW, Australia` → the AU country centroid). These cases concentrate in the bare-fragment,
  > US-highway, and bare-state-name classes.

Caveats on that experiment: It measures divergence between neural and rules rather than accuracy
against ground truth, because the corpus has no gold coords and the rules parser is sometimes the
wrong one. The corpus is also deliberately heavy on fragments and edge cases, so real drop-in
traffic should show a smaller tail than the 21% seen here.

## What I built, and where it conflicts with the spec

- **Resolution-plausibility guard:** `resolver/plausibility.ts` exports
  `isImplausibleResolution(tree)`. It has 6 passing tests and is committed on branch
  `feat/v7-hybrid-swap-check` (not merged). It trips when a tree resolves no finer than a country
  centroid, and it works in either check direction. [done]
- I then drafted a **hybrid swap check** that routes `structured_address` to neural, sends
  everything else to the rules fallback, and applies the guard. I measured that it limits the tail
  of bad output to ~3/321 (0.9%) with zero false-positive fallbacks. **This keeps rules as a
  fallback, which demotes rules rather than deleting them.** The held `/v1/parse` swap's own
  docstring says its design is "no rules fallback (the legacy-excision's point)." The hybrid
  therefore **contradicts the option-A delete spec**. That is a spec-level decision that belongs
  to the operator, so I stopped before wiring it.

## Changes considered and not committed to

- **Digit-atomicity tokenizer splice.** A probe confirmed the _cause_: the tokenizer splits
  multi-digit numbers into single digits (`810`→`▁8 1 0`), so the boundary can fall inside a
  number. [measured] I have **no evidence that the fix works**. `16a` tokenizes atomically (`▁16`)
  and is still absorbed into the street, and the cited literature (GLiNER, Filtered Semi-Markov CRF,
  Yin'23) points at structured span prediction rather than digit atomicity. Launching a retrain on
  the cause alone would over-commit on a confirmation I generated myself. [hypothesis, unvalidated]
- **#727 stage-2 (FSemi-CRF span head).** The runbook names this as the next model arc for the
  boundary class. Stage-1 (the aux head) plateaued at 5→2 flips. It is explicitly a multi-night
  architecture build (new export path, #378 SLO, capability rework), so it needs its own dedicated
  workstream rather than a launch at the end of a session.
- **29M extract campaign.** Deprioritized. The v250→v257 campaign already added 12.0-weight targeted
  extracts and plateaued, and more extracts would plateau again. [concluded]

## Open decisions for you (in priority order)

1. **What is the acceptance criterion for deleting rules?** The parse-tag floor is a proxy that a
   29M model may not reach. Candidates:
   - (a) Hold the 0.90/0.97 parse-tag floors and invest in the model until it clears them.
   - (b) Decide deletion on the coordinate acceptability of the swapped surfaces instead.
   - (c) Accept a thin rules fallback for the classes the model cannot handle. That demotes rules
     and weakens "delete".
   - (d) Some mix.

   Everything else waits on this decision.

2. **Is demote-with-fallback acceptable, or is delete non-negotiable?** If delete is firm, the
   hybrid check is off the table, and the path is model investment (FSemi-CRF, the PT-RO splice, or
   digit work) until the model handles the failing classes on its own.
3. **If we invest in the model, which change comes first?** The options are FSemi-CRF
   (literature-backed, multi-night), a PT/RO diacritic splice (fills a confirmed coverage gap), or a
   digit-atomicity probe (validates the fix before the retrain).

## Artifacts + state

- Branch `feat/v7-hybrid-swap-check` (off main) contains the plausibility guard and its tests,
  committed but not pushed.
- Held swaps: `origin/hold/v1-parse-neural-check-blocked` (T1 libpostal / T2 /v1/parse / T4
  nominatim), blocked by `mailwoman/test/v1-parse-check.test.ts` (the 0.90/0.97 parse-tag floors).
- Diagnosis write-up: `docs/articles/evals/2026-07-15-v7-parity-floor-diagnosis.md`.
- Probes (repro): `scratchpad/{coord-parity,ctx-probe2,tok-probe,tok-digits,parity-split}.mjs`, and
  a package-shaped v264 cache at `scratchpad/v264-cache`.
- Memory: `project-v7-legacy-excision-arc` (updated with tonight's night-2 entry).

## Cheap things to verify next (before any GPU)

- Partition the 122 street failures by number position (leading, trailing, none) and form (plain,
  multi-digit, alphanumeric). Check whether the failure rate tracks those groups, which tests the
  claim that failures diverge from the number template instead of judging it by eye.
- Re-score CZ on both resolve-match and parity street-tag to confirm that the diacritic misses are
  a visibility issue and not a regression.
- If digit atomicity stays on the table, get an independent opinion (a DeepSeek consult plus the
  cited papers) on digit-splice versus FSemi-CRF before committing to a retrain.
