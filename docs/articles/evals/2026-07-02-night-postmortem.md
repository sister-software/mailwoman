# Night Shift Postmortem — 2026-07-01/02 (30th shift)

Living document — sketched during the shift, finalized at hand-off. Window: ~05:30 UTC → 15:00 UTC.
Posture: autonomous, CPU/local, ~$0 Modal (GPU levers flagged, not run). PRs shipped + flagged for
operator merge (no self-merge).

## What shipped / opened

- **Diagnostic scripts repaired** — 21 untracked `scripts/diagnostic/*` + eval scratch scripts broken by
  the v5.0.0 acronym rename now `typecheck:scripts` clean (**70 errors → 0**). Fixed the rename collateral
  (Wof/Osm/Json/Id/Us) + the pre-existing strict-null gaps; left `casing-ab`/`portland-833b` async-drift
  fixed too. Untracked, so local-only.
- **#875 filed** — the v5.0.0 sweep missed two acronyms: `Us` and generic `Json`/`Jsonl` (~28 identifiers,
  some public). Documented in AGENTS.md as a version-gated batch.
- **PR #876** — `recognizeUsRegions` → `recognizeUSRegions` (internal-only slice of #875; no public
  re-export → zero release impact). Compile + affected tests green. Flagged for merge.
- **Coverage quantified (lever C, closes the #823 loop).** Ran `frontier-gap.ts` against the live
  `candidate.db` (→ `candidate-global-coverage.db`, the post-#266/#267 build), geonames cities15000 top-2/country:
  **resolve-rate bare 88.9% → +hint 94.3%**, across 187 countries. **181 bare-supported · 3 placer-recoverable
  (AR/GE/PR — 0→2/2 with hint, the #244/#822 lever) · 3 residual · 0 wrong-place.** The residual is a clean
  exonym-indexing lever: Israel/Kuwait/Antigua fail because the English name (Tel Aviv, Kuwait City) matches no
  in-country record — index alt-name surface forms (Warsaw↔Warszawa is already proven). Down from the ~97
  residual countries the coverage arc started with. #823 was closed on a 5-city spot-check; this is the honest
  full measure.
- **#305 — measured + FALSIFIED (not shipped).** Implemented the proximity gate on the coord-first exact
  tier (`coordFirstExactProximityKm`, default-off/byte-stable), A/B'd on the JP end-to-end eval:
  baseline KEN_ALL 98.5% / GeoNames 93.9% → **gated 90.3% / 72.8%** (−8/−21pp). 50km ≡ 200km (identical),
  so it's the `pcInfo`-membership gate suppressing correct FTS-exacts, not distance. Reverted; posted the
  data + redesign direction to #305; lowered priority (the 98.5% baseline is already good, the existing
  mismatch-flag is the right conservative behavior).

- **Exonym-residual diagnostic (#877).** Dumped C's 3 residual cities against the live gazetteer — all
  **exist** (Tel Aviv pop 432k, Kuwait City, Jerusalem), so the endgame is indexing/ranking, not more data.
  The bare-form keys **match** (`normalizeLocalityForKey("Tel Aviv")` = `"tel aviv"` = 1 row); the frontier
  miss is the geonames name-**variant** (`Tel Aviv-Yafo` → `"tel aviv-yafo"` = 0 rows) + primary/pop ranking.
  Filed + corrected #877.

- **PR #878 — unknown-span report (#493 acceptance item).** A tracked eval that runs the parser over golden
  and aggregates the all-O runs into a corpus-gap shopping list, **separating trivial delimiter gaps from
  content gaps**. Honest read: **9.0% content-gap rate** (1.0% of chars; the raw 98% is delimiters). Top
  signal (verified): accented/foreign-influenced mis-segmentations (`Montréal, QC` → model drops the `C`;
  clean `Austin, TX` tags fine) → an accent-robustness lever, plus fr `sainte`, plus non-Latin scripts.

- **Multi-locale corpus-gap read → #825 shopping list (verified).** Ran the #878 tool over the `oa-*-coord-150`
  external OpenAddresses sets. **CZ 84% / PL 77%** content-gap rate (the worst by far; PT 27, AT 15, FR 10, IT 2,
  AU 0, US 0). Root cause **verified by dumping cases** (probe before write-up this time): a **Slavic-diacritic
  tokenization/offset failure** — `Grudziądz` splits at `ą`, `Bohaterów` at `ó`, and the span shift eats trailing
  digits (`39`→`9`). Told #825 the lever is diacritic robustness + CZ-in-scope, not per-locale volume (AU/US
  already 0%). The 3 PRs (#874/#876/#878) all verified MERGEABLE/CLEAN + green.

## What went well

- **Verify-before-verdict earned its keep on #305.** The issue's hypothesis was plausible; the eval said
  −21pp. Shipping on the hypothesis would have been a real regression. Grade the assembled output.
- **Scope discipline on the acronym gaps.** The `Json` sweep is ~28 identifiers across packages incl.
  public API — recognized it as a version-gated batch, not an overnight slip-in, after a partial sweep
  half-renamed callers vs their def (caught + reverted immediately).

## What could've gone better

- **Spent disproportionate effort on untracked scratch scripts early** (the `Fix'em up` task). 70→0 was
  the ask, but it ate several tool-cycles on throwaway diagnostics with genuine API drift. Time-budget
  discipline: the rename collateral (my v5.0.0 doing) was the core; the pre-existing strict-null was gravy.
- **Over-narrated the mechanism before verifying — TWICE (#877 name-key, #878 partial-token).** Both times
  I wrote the causal story ("name-key mismatch", "systematic region-abbrev truncation") into an issue/PR
  before running the one probe that tests it; both times the probe flipped the story (keys DO match; clean
  region abbrevs DO tag). Caught + corrected each on the next step, but the pattern is clear: **the numbers
  were solid, the mechanism interpretation kept outrunning the probe.** Rule for the rest of the shift and
  next: dump the specific case BEFORE writing the "why", not after. The verify-before-verdict reflex fired
  on the correction, not the claim — it needs to fire one step earlier.

## Decisions made autonomously

- **Did not ship #305.** A default-off lever that regresses 21pp when enabled is misleading scaffolding,
  not a fix. Reverted rather than ship-behind-a-flag.
- **Deferred the `Json`/public-`Us` acronym batch to the operator** (breaking, version-gated) rather than
  do a piecemeal overnight sweep.

## Open questions / for the operator

- **#875** — do we want a deliberate acronym-completion pass (`Json`/`Jsonl` + public codex `Us`) bundled
  into the next major? Or leave the convention gap? (Internal `recognizeUsRegions` already done in #876.)
- **PR #874** (env SDK → `@mailwoman/core/env`) + **PR #876** await your merge.

## Numbers

| | |
|---|---|
| Shift window | ~05:30–15:00 UTC |
| Models trained | 0 (no Modal budget) |
| Modal $ | $0 |
| PRs opened | #876 (+ #874 from the day session) |
| Issues filed | #875 |
| Evals run | JP resolver A/B (falsified #305) |
| Regressions shipped | 0 |
