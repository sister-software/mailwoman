# The coverage register — phase 1 of inferential resolution

Night-shift design record, 2026-08-11. It accompanies
[`../plans/2026-08-08-inferential-resolution.md`](../plans/2026-08-08-inferential-resolution.md).
We ran that record's pre-registered falsifiers tonight, and all three runnable ones
pointed to the same missing dependency. This note combines their results and proposes a build item.
It is a design record for operator review rather than a plan of record.

## The evidence that converged

Receipts are in `scratchpad/falsifiers/` (probes, JSON outputs, and `GRADING.md`). Each falsifier's bars
were fixed before it ran.

1. **Negative evidence cannot fire yet** (falsifier 1). Of the 47 panel-v2 rows that the benchmark's
   mailwoman arm missed by >25 km, **35 fall where we hold no street set at all**, so exclusion has
   no set to check against. In 7 more, the queried street exists near the wrong answer. Exactly
   one candidate set shrinks (`LOT 373 Clifton Street, Sandstone WA 6639`, where we hold 11 streets and
   none is Clifton). The design doc's kill condition, "the coverage register is not complete enough for
   this to bite yet", is met on its own terms.
2. **The CPT density prior cannot be graded without coverage** (falsifier 3). Grocery fits at 59.8%
   holdout median error (WEAK) and pharmacy at 75.3% (KILLED). However, poi.db's own register asserts
   `completeness = 1.0` everywhere. That default violates the board's meaning-of-zero rule. Observed counts are therefore
   lower bounds with unknown coverage, and the residual mixes theory error with missing data.
   The fit cannot be graded better than WEAK until the register reports measured coverage.
3. **The largest benchmark deficit is a coverage gap that looks like a mechanism defect** (#1585). The
   en-nz lane scores 3/60 @1km, while a local nz-only OSM import answers 58/60. The missing admin layer
   is ~7,630 place nodes, including 963 suburbs such as `Stanmore Bay`. The resolver's fuzzy
   typo-corrector then crosses country scope because no coverage assertion tells it "NZ is unsurveyed
   here, abstain". The wrong answer (`Stanmore Bay` → "Banmore", IN) is what a missing coverage
   assertion produces at runtime.

In summary, **every inference the design record proposes depends on knowing what data we hold,
and today no layer can report what it holds.**

## What already exists

The layer interface (`docs/engineering/reference/layer-interface.mdx`) already requires a
`layer_coverage` table in every layer database, and the meaning-of-zero rule already states that a
magnitude never carries its own absence. The interface is correct, but the values stored in it are wrong or
missing:

- poi.db ships `completeness = 1.0` for every cell (board #26). The value was a default and was never
  measured.
- The address-point DBs (US per-state, 124.9M points) carry no per-locality completeness at all.
  That is why falsifier 1 had to improvise its "held street set" from row counts.
- The candidate gazetteer cannot record that a country's locality tier is unsurveyed. The NZ
  gap looks the same as a fully covered country without a matching name.

## The register's interface (proposed)

Phase 1 carries two kinds of coverage, because the resolver asks two questions with
different keys (operator correction, 2026-08-11 handoff §4):

- **Spatial coverage** answers "how complete is this layer here?" It needs a geometry, so it applies
  only to a claim that already resolved to a coordinate.
- **Scope coverage** answers "was this layer's namespace surveyed at all?", which is the question an
  unresolved lookup asks. `Stanmore Bay` has no candidate row, so it has no coordinate and
  no H3 cell. A per-cell table therefore cannot tell the resolver that the NZ locality namespace
  was never surveyed. Giving an H3 cell a country-wide meaning is forbidden, so the two
  kinds of coverage stay in separate tables.

### Cell coverage (`layer_coverage`, per resolved geometry)

Each layer has one assertion row per H3 cell (res 7 for admin/locality layers, and res 9 where the layer already clusters at
9):

```
(layer_id, h3_cell, state, basis, as_of, source_release)
  state ∈ { surveyed_complete   — a completeness CLAIM with a named basis, never a default
          , surveyed_partial    — rows exist; completeness unknown or known-partial
          , observed_no_match   — the cell was processed and holds nothing (a real zero)
          , unsurveyed          — outside every source extract that fed this layer
          }
```

### Scope coverage (`layer_scope_coverage`, per unresolved name lookup)

Each layer has one assertion row per (country, placetype-or-namespace). The row uses the same state vocabulary
and the same basis / vintage / source-release fields as cell coverage:

```
(layer_id, country, namespace, state, basis, as_of, source_release)
  namespace — a WOF placetype (`locality`, `postalcode`, …) or a layer-declared namespace label;
              the minimum key is (layer, country, namespace), and the name
              `layer_scope_coverage` holds until schema review picks the final term
```

A resolver reads the scope row before it has a coordinate. `(candidate, NZ, locality)` →
`surveyed_partial` means the region and locality tiers exist but the suburb tier does not. That answer differs
from `(candidate, US, locality)` → `surveyed_partial` with a miss, and both differ from a
namespace nobody ever extracted. The #1585 fuzzy-scope mechanism (shipped 2026-08-11) carries out the
abstention. Scope coverage will let it abstain with a named reason, where today it abstains only
because no candidates exist.

Three rules from the OSM-ingest section of the design record carry over, now generalized:

1. **`surveyed_complete` requires evidence and is never a default.** A basis states how the claim is known (an
   authority's own completeness statement, a reconciliation against a second source above a
   threshold, or a census denominator). A row without a basis gets `surveyed_partial`. This reverses
   the poi.db defect exactly.
2. **A real zero is stored differently from a missing survey** (`observed_no_match` vs `unsurveyed`).
   This turns the meaning-of-zero rule from prose into a stored state.
3. **Only `surveyed_complete` can power hard negative evidence.** `surveyed_partial` may adjust
   ranking with positive evidence only, per the registry doctrine. The other two states may not affect ranking at all.

The register is a companion table inside each sealed artifact. The artifact is rebuilt and swapped, never patched, and the table is
readable through `@mailwoman/core/layers` beside the existing manifest.

## What it unlocks, in dependency order

1. **Runtime abstention** (the interface half of #1585). Consider a locale-hinted query whose scoped fuzzy probe
   targets a namespace whose `layer_scope_coverage` row is not `surveyed_complete`. That query abstains at that
   tier with a named reason instead of falling through to world-fuzzy. It reads the scope row rather than a cell,
   because the query has no coordinate to key a cell with. This change alone turns the NZ failure from a
   silently wrong answer into an explicitly empty one before any new data ships. (The abstention mechanism shipped as the
   #1585 fuzzy-tier country restriction. Today it abstains because candidates are absent and gives no named
   reason.)
2. **The NZ locality extract lands with measured coverage**: ~7.6k rows, from LINZ for the permissive tier, while the OSM copy
   stays build-local under the ODbL policy. `surveyed_complete` is asserted from the
   authority's own coverage statement, which makes this the first layer whose register is accurate from its first build.
3. **Falsifier 1 can be re-run as a real test**: negative evidence is scoped to
   `surveyed_complete` locality cells, and the count of candidate sets that shrink usefully becomes the
   register's own acceptance metric.
4. **Falsifier 3 becomes gradable**: fit the CPT prior only in `surveyed_complete` POI cells, so that the
   residual measures the theory rather than the coverage. The poi.db register rebuild (board #26)
   is the prerequisite. Under the standing rule, it must be a full rebuild of the sealed artifact.
5. **Benchmark receipts become more specific**: every discrepancy row can end in "coverage change" with a
   cell-level citation instead of an inference.

## Explicitly out of scope for phase 1

Phase 1 excludes everything generative:

- Naming-family mining. Falsifier 2 measured 19.5% of localities carrying a
  detectable family. The families are real but a minority, and numbered grids dominate them. Mining keys off the same per-locality
  street sets the register indexes, so it waits until the register exists.
- Terrain/plant exclusion.
- Any `inferred` result emission.

Provenance in the result shape (`retrieved` /
`interpolated` / `inferred`) is cheap and useful on its own, but it is a separate, smaller change.

## Falsifiers for the register itself (before building)

These are the five scope-interface proof cases from operator handoff §4. All five must pass on a prototype
before the full register is built. Receipts are in `scratchpad/falsifiers/f4-scope-coverage.mjs`.

1. Query NZ locality coverage without a candidate coordinate. The scope row must answer where no cell
   key exists.
2. Distinguish an unsurveyed locality namespace from a surveyed namespace without a match. These must be two
   different stored states rather than one shared absence.
3. Keep exact foreign matches available under a locale hint. Only the fuzzy/derived tiers consult
   scope coverage, and the exact tier never reads it. The Paris row on the #1585 board is the
   standing conditional test case.
4. Prevent hard negative evidence from a partial namespace. Only `surveyed_complete` can power a
   negative, and the interface must refuse `surveyed_partial` for that use.
5. Reconcile sampled `surveyed_complete` claims against a second source. The disagreement rate measures
   the claim's calibration, and the schema must support the reconciliation query.

Three more carry over from the night design:

6. Does a poi.db register with measured coverage change falsifier 3's grade? Re-fit on `surveyed_complete` cells
   only. If MARE stays ≥ 60%, the CPT prior fails on theory rather than coverage, and that result is useful either way.
7. Do `surveyed_complete` claims survive audit? Sample N cells claimed complete and reconcile them against
   a second source. The disagreement rate measures the claim's calibration.
8. Does tier abstention (#1) regress any currently correct answer? Run the guard board and panel-v2 with
   abstention on and off. The D-rule applies before abstention becomes the default.
