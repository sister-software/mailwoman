# Night 15 postmortem — the autonomous follow-on (2026-06-14)

_The autonomous shift after the v4.7.0 geocoder-campaign ship. Plan: the six workstreams A–F of
`nightshift/2026-06-14-NIGHT-SHIFT-PLAN.md` — reconcile re-gate, coarse-placer M3, multi-region interp
recalibration, autocomplete, the marquee client-side demo geocoder, and issue housekeeping. All six
landed (D was already shipped); the marquee shipped working and browser-verified. Nine PRs, five issue
closures, plus an unplanned CI rescue — fully greened — that unblocked the whole shift._

## What shipped

**Pre-flight rescue (unplanned, first action):**

- **#579** — CI was fully red on `main` and nobody had noticed. A Storybook/Vite-8 bump (`fdc4bcac`)
  committed without regenerating `yarn.lock` broke `yarn install --immutable` (the first step of every
  workflow). Under it sat two more latent failures the install-block had hidden: vite 8 broke the
  `vitest.config` `defineConfig` typing, and vitest was collecting a Playwright `.spec.ts`. Fixed all
  three; CI went **0 → 224/231** test files passing.
- **#589** — chased the one residual red to ground (first filed as #582, *guessed* to be weights/WOF
  absence — wrong). `mailwoman/test/locale-flag.test.ts` is the only suite that shells out to the
  **compiled** CLI (`execFile out/cli.js parse`). `repo.ts`'s `__isCompiledTree` detection lands the
  core package root at `core/out`, so the compiled parser reads dictionaries from `core/out/data/…` —
  a path that only exists once something creates the `core/out/data → ../data` bridge. Locally that's a
  side-effect of `promotion-gate.sh`; CI never ran the gate, so the first rule-path parse `ENOENT`s and
  every `parse` fails (the same bridge issue behind night-13's `arena.perturb NOT FOUND`). Fix: mirror
  the sanctioned bridge as a Test-workflow step after compile — makes the suite genuinely pass **without**
  provisioning weights. Validated locally (pull the symlink → 5 fail; restore → 5 pass). The proper
  `repo.ts`-detection fix stays deferred to daylight review (#481). **This greens CI fully (225/225).**

**A — reconcile re-gate (#580):** Graded the assembled pipeline (never raw neural) in argmax vs
reconcile mode after the #565 grouper fix. Reconcile is **strictly worse**: US street −2.4pp, FR street
**−13.7pp** (the locale #427 claimed it helped), and it still breaks the geocoder precondition on 5.6%
of OA rows where argmax never does. **Keep retired** — parked decision resolved, DeepSeek-concurred.

**B — coarse-placer M3 (#581):** int8 quantization (3.15 MB → 0.79 MB, 4×, **−0.01pp** accuracy) +
`CoarsePlacer.fromArtifactDir` loader (9 tests). The Latin-off-map experiment: real off-map addresses
make trained countries **23% → 100%** handled at zero in-map cost, but it **doesn't generalize** to
unseen countries — a data-breadth ceiling, not a method failure (Overture's ALPHA addresses theme is
sparse). Honest finding, not promoted.

**C — multi-region interp recalibration (#584):** The conformal interp-radius factor (1.70, #569) is a
**Texas artifact**. Measured across 12 states (situs OA/NAD as non-circular ground truth for TIGER
interp): Q̂ ranges **1.44 (DC) → 3.12 (AZ)**, a 2.2× spread monotonic with rurality. The single 1.70× is
overconfident in rural states (dangerous) and over-conservative in dense cities. Ships the finding + a
seed per-region calibration table + reusable tooling. PR-and-flag (wiring per-region changes shipped
`uncertainty_m`).

**D — autocomplete (CLI #547 + algorithm fix #588 + demo typeahead in #585):** The CLI was already
shipped (#547, 21 tests); the plan's "unwired" was outdated. Wiring it into the demo surfaced (per
DeepSeek's hint) that the FST `autocomplete` was **token-level, not char-level** — "New Yor" → "Denver",
and "New" → "New London" ×4 (no name-dedup, off ranking). Fixed it (**#588**): on a failed walk, walk
the complete prefix and prefix-filter continuations by `startsWith(partial)`; added per-branch importance
capping (`PER_BRANCH = 4`) + opt-in `dedupeByName`; 7 synthetic unit tests. Now `New Yor`→New York,
`Chic`→Chicago, `San Fr`→San Francisco. The demo box shows a live "Did you mean:" chip row (#585),
now a full keyboard **combobox** (↑/↓ highlight, Enter accepts + suppresses the form submit, Esc dismisses;
ARIA `role=combobox`/`listbox`/`option`) — functional-verified headless **8/8** against the production
build, FST fetched live from R2, zero console errors. Only the *address-level* (street-prefix) typeahead
remains, deferred to **#587**.

**E — the marquee: client-side street geocoder (#583 spec + #585 working demo):** **Shipped working and
browser-verified.** Type a US address → exact building coordinate, fully in the browser, no server.

- Spec (#583): byte-range proven on the **3.3 GB CA shard** (~24 KB/lookup, index B-tree depth 4); the
  sync/async architecture resolved (the demo's cascade is already async, so no worker needed for
  correctness).
- Implementation (#585): async httpvfs situs/interp lookups (twins of the node tiers, lockstep) +
  `resolveStreet` + the `index.tsx`/marker/types wiring + a precision caption ("📍 exact address point
  (≤10 m)" / "≈ interpolated · ±N m"). Hosted the **full launch trio NY/MI/CA + DC** on R2 byte-range.
- **Verified in-browser (Playwright/run-docs) on all four** — each resolves to its exact `address_point`,
  fully client-side, zero console errors: DC (the White House, 38.8977/-77.0365, 8.3 s), MI (4.8 s), NY
  (5.8 s, 1.4 GB shard), and **CA (5.5 s on the 3.3 GB stress shard)** — closing the spec's go-wide
  latency question. Fixed a street-assembly bug CA exposed (the model splits `street`+`street_suffix`;
  now assembled in source order). The #377 UX cluster (span-highlight, hierarchy, candidates, timing) was
  already built; this shift added the live street tier + precision caption on top.

**F — issue housekeeping:** Closed **#483, #484, #523, #560, #397** (verified shipped); triaged **#374,
#481, #368** (kept open with status); filed **#582, #587**.

## What went well

- **Pre-flight caught the CI fire.** The `yarn install --immutable` check surfaced a fully-red `main`
  nobody had flagged. Fixing it first meant every PR opened tonight had a clean CI story (modulo the
  flagged pre-existing weights condition).
- **Grade-the-pipeline discipline paid off again.** The A re-gate and the C non-circular holdout both
  came from the same rule that caught the original reconcile regression — never trust raw-neural F1.
- **Probe-before-build saved hours twice.** The byte-range *measurement* (24 KB/lookup) de-risked the
  whole marquee before a line of demo wiring; the Overture off-map *probe* found the data ceiling before
  a wasted retrain campaign.
- **The marquee actually works.** The biggest risk item shipped browser-verified, not as a "foundation +
  guide." Reusing the existing httpvfs WOF pattern + the already-async demo cascade made it tractable.

## What could've gone better

- **Misjudged the clock for ~3 hours.** File mtimes are lab-local time; I read them as UTC and thought
  the shift was 4× further along than it was. Corrected on the first `date -u`. Lesson: `date -u` early
  and often.
- **The full 50-state sweep broke on a branch switch.** `build-situs-holdout.mjs` lived on the C branch;
  switching to the E branch mid-sweep removed it, so 43 states came back blank. Re-ran branch-independent
  from `/tmp`, then hit the >85 °C heat ceiling and abandoned at 12 states (enough to confirm the
  finding). Lesson: background sweeps must not depend on the working-tree branch.
- **A self-inflicted empty-DB stumble** (read-only `node:sqlite` can't create the no-op situs file) cost
  a couple iterations on the interp-only conformal runs.
- **Filed #582 with a guessed root cause.** I labelled the last CI red "weight-dependent integration
  tests" from the test name alone, without reading the failure. It was actually the compiled-data bridge
  (`core/out/data`) — provable in two minutes by pulling the symlink locally. The guess wasn't *wrong*
  enough to be harmless: it framed the fix as a costly CI-data-provisioning decision (the 3 options in
  the issue) when the real fix was a one-line symlink. Lesson: a one-line repro beats a plausible label —
  read the actual error before writing the issue. Fixed properly in #589.

## Decisions made autonomously

- **Fixed CI on a branch + flagged for fast-merge** rather than pushing to `main` (merge wall). The
  alternative — pushing the lockfile fix straight to `main` — would've unblocked everyone's CI faster but
  violated the no-self-merge rule. Chose discipline + a prominent flag.
- **Kept reconcile retired** (A) — reversing #427's positive claim — on the strength of the assembled-
  pipeline numbers, DeepSeek-concurred.
- **Did not promote coarse-placer M3** (B) despite it being a strict Pareto improvement — it doesn't meet
  the ≥90% general target, and "experimental" isn't a participation trophy.
- **Killed the 50-state sweep at 92 °C** (over the 85 °C rule) to free CPU for the marquee verification.
  The 12-state result already proved C; the full table is a bonus.
- **Chose DC for the marquee verification** (the White House resolves to its exact building) — a more
  compelling proof than the plan's NY/MI/CA, which I then hosted as the launch set.

## Open questions (operator)

- **Wire per-region interp calibration (C)?** The seed table is ready; wiring it changes shipped
  `uncertainty_m`. Per-region table now, or hold for the per-segment-length-bucket refinement?
- ~~**CI weights provisioning (#582)?**~~ **Resolved** — the residual red wasn't weights at all; it was
  the compiled-data bridge (#589, closes #582). Open sub-question for daylight: take the *proper*
  `repo.ts` `__isCompiledTree` fix (#481) so no bridge is needed anywhere, vs. keep the sanctioned
  symlink workaround.
- **Coarse-placer breadth (B)?** A full OpenAddresses off-map pull would close the Latin residual; worth
  the data acquisition?
- **Promote anything?** Nothing was promoted to a shipped default tonight (all PR-and-flag). The
  marquee demo is a docs deploy, not a model release.
- **Autocomplete typeahead — fixed and shipped (#588 + #585), address-level variant deferred.** My first
  wire surfaced (confirming DeepSeek's hint that "there's more here than described") that the FST
  `autocomplete` was **token-level, not char-level**: "New Yor" returned garbage ("Denver"), and even
  complete tokens had quality issues ("New" → "New London" ×4, not New York — no name-dedup, off
  importance ranking). Rather than ship a demo that fails the hostile-interviewer test, I fixed the
  algorithm: when the FST walk fails on a partial last token, walk the complete prefix and prefix-filter
  continuations by `startsWith(partial)`; added per-branch importance capping (`PER_BRANCH = 4`, fixes
  the "New London" starvation) and an opt-in `dedupeByName`. Verified `New Yor`→New York, `Chic`→Chicago,
  `San Fr`→San Francisco, `New`→New York|New Haven|New London; 7 new synthetic unit tests, all green.
  The demo box now shows a live "Did you mean:" chip row (#585), deploy-verified in the production build.
  **Open for the operator:** only the *address-level* (street-prefix) typeahead remains — a separate
  street index, documented as a follow-up in #587. The place-level typeahead the plan asked for is done.

## Concrete next steps

- Merge **#579 then #589 first** (together they green CI fully), then the rest
  (#580/#581/#583/#584/#585/#588). #588 (autocomplete algorithm) lands before #585 (demo) so the
  typeahead wires against the fixed `fst-autocomplete.ts`.
- **E go-wide:** finish hosting NY + CA (uploading), add them to `HOSTED_STREET_SLUGS`, verify a CA
  address in-browser (closes the spec's go-wide latency decision on the real 3.3 GB shard).
- **E UX (#377):** tier caption ("exact" / "±N m") and place-level autocomplete typeahead are shipped;
  remaining is span-highlight, the resolved-hierarchy tree, the address-level (street-prefix) typeahead
  (#587), then lifting the cascade into a Web Worker + the capped Service Worker cache.
- **B:** int8-quantize is done; the broad off-map pull is the next accuracy lever.
- **C:** finish the 50-state sweep (heat-managed) → complete the calibration table.

## Numbers

| metric                  | value                                                          |
| ----------------------- | -------------------------------------------------------------- |
| shift window            | 2026-06-14 03:47 → ~15:00 UTC                                  |
| PRs opened              | 9 (#579, #580, #581, #583, #584, #585, #586, #588, #589) + #582/#587 issues |
| issues closed           | 5 (#483, #484, #523, #560, #397) + 3 triaged                   |
| models trained          | 1 (coarse-placer M3 retrain, 34 s CPU)                         |
| Modal / GPU time        | 0 (CPU-only shift, as planned)                                 |
| marquee verification    | 4 states in-browser (DC/MI/NY/CA), all exact, zero errors      |
| R2 hosted street shards | DC + MI + NY + CA (the full launch trio + DC), all verified    |
| NaN incidents           | 0                                                              |
| CI status               | rescued 0 → 224/231 (#579); last red root-caused + fixed (#589) → fully green |
| peak heat               | 92 °C (sweep; killed per the 85 °C rule)                       |
