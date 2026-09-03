# The coverage register — phase 1 of inferential resolution

Night-shift design record, 2026-08-11. Companion to
[`../plans/2026-08-08-inferential-resolution.md`](../plans/2026-08-08-inferential-resolution.md);
this note exists because that record's pre-registered falsifiers were RUN tonight, and all three
runnable ones converged on the same dependency. This is the synthesis and the proposed build item —
a design record for operator review, not a plan of record.

## The evidence that converged

Receipts in `scratchpad/falsifiers/` (probes + JSON outputs + `GRADING.md`), each with bars fixed
before its run:

1. **Negative evidence cannot fire yet** (falsifier 1). Of the 47 panel-v2 rows the benchmark's
   mailwoman arm missed by >25 km, **35 land where we hold no street set at all** — exclusion has
   nothing to exclude against. 7 more have the queried street present near the wrong answer. Exactly
   ONE candidate set shrinks (`LOT 373 Clifton Street, Sandstone WA 6639`, 11 held streets, no
   Clifton). The design doc's kill condition — "the coverage register is not complete enough for
   this to bite yet" — is met on its own terms.
2. **The CPT density prior is unratable without coverage** (falsifier 3). Grocery fits at 59.8%
   holdout median error (WEAK), pharmacy at 75.3% (KILLED) — but poi.db's own register asserts
   `completeness = 1.0` everywhere (the board's meaning-of-zero violation), so observed counts are
   lower bounds with unknown coverage and the residual conflates theory error with data absence.
   The fit cannot be graded better than WEAK until the register is honest.
3. **The largest benchmark deficit is a coverage gap wearing a mechanism defect** (#1585). The
   en-nz lane sits at 3/60 @1km; a local nz-only OSM import answers 58/60. The missing admin layer
   is ~7,630 place nodes (963 suburbs — `Stanmore Bay` among them). The resolver's fuzzy
   typo-corrector then crosses country scope precisely because nothing tells it "NZ is unsurveyed
   here, abstain" — the wrong answer (`Stanmore Bay` → "Banmore", IN) is what an absent coverage
   assertion looks like at runtime.

One sentence: **every inference the design record proposes is downstream of knowing what we hold,
and today no layer can say what it holds.**

## What already exists

The layer contract (`docs/engineering/reference/layer-contract.mdx`) already REQUIRES a
`layer_coverage` table in every layer database, and the meaning-of-zero rule already states that a
magnitude never carries its own absence. The contract is right; the FILLINGS are dishonest or
absent:

- poi.db ships `completeness = 1.0` for every cell (board #26) — the value was defaulted, not
  measured.
- The address-point DBs (US per-state, 124.9M points) carry no per-locality completeness at all,
  which is why falsifier 1's "held street set" had to be improvised from row counts.
- The candidate gazetteer has no notion of "this country's locality tier is unsurveyed" — the NZ
  hole is indistinguishable from a fully-covered country with no matching name.

## The register's contract (proposed)

Phase 1 carries TWO kinds of coverage, because the two questions a resolver asks arrive with
different keys (operator correction, 2026-08-11 handoff §4):

- **Spatial coverage** answers "how complete is this layer HERE?" — it needs a geometry, so it can
  only be asked about a claim that already resolved to a coordinate.
- **Scope coverage** answers "was this layer's NAMESPACE surveyed at all?" — the question an
  UNRESOLVED lookup asks. `Stanmore Bay` has no candidate row, therefore no coordinate, therefore
  no H3 cell; a per-cell table cannot tell the resolver that the NZ locality namespace is the thing
  that was never surveyed. Overloading an H3 cell with country-wide meaning is forbidden — the two
  axes stay separate tables.

### Cell coverage (`layer_coverage`, per resolved geometry)

Per layer, per H3 cell (res 7 for admin/locality layers, res 9 where the layer already clusters at
9), one assertion row:

```
(layer_id, h3_cell, state, basis, as_of, source_release)
  state ∈ { surveyed_complete   — a completeness CLAIM with a named basis, never a default
          , surveyed_partial    — rows exist; completeness unknown or known-partial
          , observed_no_match   — the cell was processed and holds nothing (a real zero)
          , unsurveyed          — outside every source extract that fed this layer
          }
```

### Scope coverage (`layer_scope_coverage`, per unresolved name lookup)

Per layer, per (country, placetype-or-namespace), one assertion row with the SAME state vocabulary
and the SAME basis / vintage / source-release discipline as cell coverage:

```
(layer_id, country, namespace, state, basis, as_of, source_release)
  namespace — a WOF placetype (`locality`, `postalcode`, …) or a layer-declared namespace label;
              the minimum key is (layer, country, namespace), and the name
              `layer_scope_coverage` holds until schema review picks the final term
```

The row a resolver reads BEFORE it has a coordinate: `(candidate, NZ, locality)` →
`surveyed_partial` (region/locality tiers exist; the suburb tier does not) is a different answer
from `(candidate, US, locality)` → `surveyed_partial` with a miss — and both differ from a
namespace nobody ever extracted. The #1585 fuzzy-scope mechanism (shipped 2026-08-11) is the
abstention's TRANSPORT; scope coverage is what will let it abstain with a named reason instead of
by absence of candidates.

Three disciplines carried over from the OSM-ingest section of the design record, now generalized:

1. **`surveyed_complete` is earned, not defaulted.** A basis names HOW the claim is known (an
   authority's own completeness statement, a reconciliation against a second source above a
   threshold, a census denominator). No basis → `surveyed_partial`. This is the exact inversion of
   the poi.db defect.
2. **A real zero is distinguishable from absence-of-survey** (`observed_no_match` vs `unsurveyed`)
   — the meaning-of-zero rule as a storable state instead of prose.
3. **Only `surveyed_complete` can power hard negative evidence.** `surveyed_partial` may nudge
   ranking (positive evidence only, per the registry doctrine); the other two may not even do that.

The register is a companion table inside each sealed artifact (rebuild-and-swap, never patched),
readable through `@mailwoman/core/layers` beside the existing manifest.

## What it unlocks, in dependency order

1. **Runtime abstention** (#1585's contract half): a locale-hinted query whose scoped fuzzy probe
   targets a namespace whose `layer_scope_coverage` row is not `surveyed_complete` abstains at that
   tier with a named reason, instead of falling through to world-fuzzy — the SCOPE row, not a cell,
   because the query has no coordinate to key a cell with. This alone converts the NZ failure mode
   from silently-wrong to honestly-empty before any new data ships. (The transport shipped as the
   #1585 fuzzy-tier country restriction; today it abstains by candidate absence, without a named
   reason.)
2. **The NZ locality extract lands honest**: ~7.6k rows (LINZ for the permissive tier; the OSM copy
   stays build-local under the ODbL posture), with `surveyed_complete` asserted from the
   authority's own coverage statement — the first layer whose register is honest from birth.
3. **Falsifier 1 becomes re-runnable with teeth**: negative evidence scoped to
   `surveyed_complete` locality cells; the count of usefully-shrinking candidate sets is the
   register's own acceptance metric.
4. **Falsifier 3 becomes gradable**: fit the CPT prior only in `surveyed_complete` POI cells; the
   residual then measures the theory, not the coverage. (The poi.db register rebuild — board #26 —
   is the prerequisite and is a REBUILD of the sealed artifact per the standing rule.)
5. **Benchmark receipts sharpen**: every discrepancy row can terminate in "coverage change" with a
   cell-level citation instead of an inference.

## Explicitly out of scope for phase 1

Everything generative: naming-family mining (falsifier 2 measured 19.5% of localities carrying a
detectable family — real, minority, numbered-grids-dominated; it keys off the same per-locality
street sets the register indexes, so it stays parked until the register exists), terrain/plant
exclusion, and any `inferred` result emission. Provenance-in-the-result-shape (`retrieved` /
`interpolated` / `inferred`) is cheap and useful on its own but is a separate, smaller change.

## Falsifiers for the register itself (before building)

The five scope-contract proof cases (operator handoff §4 — all five must pass on a prototype
BEFORE the full register is built; receipts in `scratchpad/falsifiers/f4-scope-coverage.mjs`):

1. Query NZ locality coverage WITHOUT a candidate coordinate — the scope row answers where no cell
   key exists.
2. Distinguish an unsurveyed locality namespace from a surveyed namespace with no match — two
   different stored states, not one shared absence.
3. Keep exact foreign matches available under a locale hint — scope coverage is consulted by the
   fuzzy/derived tiers only; the exact tier never reads it (the #1585 board's Paris row is the
   standing gated witness).
4. Prevent hard negative evidence from a partial namespace — only `surveyed_complete` powers a
   negative; `surveyed_partial` must be refused at the contract level.
5. Reconcile sampled `surveyed_complete` claims against a second source — the disagreement rate is
   the claim's calibration, and the reconciliation query must be expressible over the schema.

And the three carried from the night design:

6. Does an honest poi.db register change falsifier 3's grade? Re-fit on `surveyed_complete` cells
   only; if MARE stays ≥ 60%, the CPT prior dies on theory, not coverage — useful either way.
7. Do `surveyed_complete` claims survive audit? Sample N cells claimed complete, reconcile against
   a second source; the disagreement rate IS the claim's calibration.
8. Does tier-abstention (#1) regress any currently-correct answer? The guard board + panel-v2,
   abstention on vs off — the D-rule applies before it defaults on.
