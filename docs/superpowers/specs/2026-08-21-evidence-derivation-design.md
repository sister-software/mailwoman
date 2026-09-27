# Typed evidence and derivation — design spec

**Status:** implemented 2026-09-04/05 (plan Tasks 1–10; receipts below). **Written:** 2026-08-21.
**Public companion:** [`docs/superpowers/plans/2026-08-08-inferential-resolution.md`](../plans/2026-08-08-inferential-resolution.md). This spec implements the first increment of that design record.
**Related:** #1571 (inferential resolution), #1685 (coverage basis, landed), #1756 (`parent_fallback_retry` inert).

This spec adds a pure leaf workspace that holds the typed-evidence vocabulary, the epistemic-status
axis, the coverage-basis exclusion check, and the derivation graph. It also covers the workspace's
first four consumers.

The scope is deliberately narrow, and it does not build an inference engine. It expresses the evidence
the repository **already has** in one vocabulary, and it wires in the one check that is already built
but has never been called.

---

## 1. Why this exists

### 1.1 Three evidence vocabularies without a shared core

Three packages independently invented a way to say "here is what we know and how well we know it."
None of them can exchange that information with the others.

| Home                                       | Vocabulary                                | Confidence / status axis                                                             |
| ------------------------------------------ | ----------------------------------------- | ------------------------------------------------------------------------------------ |
| `packages/bdc/lib/sdk/plausibility.ts`     | `filing` \| `physical_plant` \| `abstain` | `coverage_confidence: high \| low \| insufficient_survey_data`, plus per-axis detail |
| `packages/resolver/lib/street-evidence.ts` | one bit — `hasStreetName`                 | none; fails open unconditionally                                                     |
| `packages/filer/` (`filer.db`)             | `filer_edge.relationship`                 | `assertion: authoritative \| inferred`, with a DB check constraint                   |

`filer.db`'s vocabulary is the strictest of the three, and SQL enforces it:

```sql
constraint "filer_family_match_score_inferred_only"
  check (match_score is null or assertion = 'inferred')
```

A score may attach only to an inference. That is the epistemic-status axis, already working in a
package that shares no code with the other two. The 2026-08-07 build measured these contents:

```
filer_node       45,215      filer_edge  31,605      filer_family  6,929      filer_cluster  0
authoritative    same_entity 18,953 · holding_company 5,752 · subsidiary 2,894
                 superseded_by 2,826 · management_company 812
inferred         parent_company 368 …
```

AGENTS.md describes what three independent implementations of the same idea indicate: there was no
shared tool to find, rather than a shared tool that nobody found.

### 1.2 The check is built and has never been called

#1685 landed `CoverageBasis` and `supportsExclusion()` in `packages/core/lib/layers/`. A grep for
consumers finds only the definition and its own unit test.

One layer already has the coverage data needed to use it:

```
uprn.db     os-open-uprn, OGL-UK-3.0, tier build-local, built 2026-08-18, sha 7b083bdc9
            layer_coverage  8,194 res-6 cells  basis = designated  completeness = 1.0
            observed_rows   41,629,393
            table `uprn`    (uprn, lat, lon, h3_cell)  ← identifier + coordinate, no name

poi.db      overture-places, vintage 2026-07-22.0, built 2026-08-19, sha 3610771ec
            layer_coverage  158,813 cells  basis = source_present  (100%)

bdc.db      build writes basis = source_present

street-centroids-fr.db   ban:fr, release 2026-05-18
            2,195,655 streets across 32,539 communes
            NO layer_coverage table at all — predates the interface
```

The layer exists, and the blocking condition is that no caller invokes the check with it.

### 1.3 The positive half is built and measured

`packages/resolver/lib/street-evidence.ts` (#727 phase 4c) is the positive counterpart, with a receipt:
**+6.0 pp street@1 (0.791 → 0.851), 96 fixes / 3 breaks, 32:1**, and most of the fixes are in the FR
date-name class. Its docstring states the assumption that designated coverage removes:

> POSITIVE EVIDENCE ONLY: the ABSENCE of a name is never evidence against a parse **(index
> incompleteness is the default state of the world)**, so the policy always fails open.

The parenthetical is true in general and false inside a `designated` cell. The negative half is
therefore a coverage-qualified mode on an interface that already exists rather than a new subsystem.

---

## 2. The three states — reachability, coverage, fold failure

`packages/dev-mcp/lib/constraint-census.ts` already separates two of the three. Its docstring states
why they must never be summed: a key held in another band needs a retrieval fix, a key held nowhere is
a data fact, and both reach a caller as `null`.

A run over the full board (591 rows) with production defaults produced:

```
591 rows → 1,609 backend lookups; 306 resolved nothing (19.0%)
  key exists in another band :  119   ← reachability, a retrieval fix
  key exists nowhere         :  187   ← coverage, a data fact
  by band                    :  locality 96 · postalcode 80 · region 11
  INERT                      :  parent_fallback_retry (196 firings, 196 nothing, 0 conversions) — #1756
```

This spec depends on the 96 locality-band rows, which fall into **several classes**:

| Class                                                                                                                                                                                                   | Rows       | Would an exclusion be correct?                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | --------------------------------------------------------------------- |
| Street fragment mis-tagged `locality` — `locality=Avenida` ← `Avenida Corrientes`; `locality=de Catalunya` ← `Rambla de Catalunya`; `locality=Turner St` ← `…Garrod Building, Turner St, London E1 2AD` | several    | **Yes.** Same shape as the FR date-name class that earned the +6.0 pp |
| POI mis-tagged `locality` — `locality=Statue of Liberty`; `locality=Great Mosque of Niamey`                                                                                                             | some       | Yes; poi.db may also hold them                                        |
| Junk span — `locality=New` ← `New Territories, Hong Kong`; `locality=near NAFTI`                                                                                                                        | few        | Yes                                                                   |
| **Fold / surface-form miss** — `locality=Tel Aviv-Yafo`; `locality=São Paulo - SP`; `locality=Co. Westmeath`; `locality=ХУД - 15 хороо`                                                                 | unmeasured | **No. This is the trap.**                                             |

The last class refers to real places. `Tel Aviv-Yafo` exists. `São Paulo - SP` exists with the state
suffix stripped. The key "exists nowhere" **only under the fold we probed with**. An exclusion would
fire on these rows with high confidence and be wrong, and at the decision point it looks identical to
a true absence.

`street-evidence.ts` already records the same problem one layer down: "the 4 v1-policy breaks were
fold mismatches: `pillet-will` stored unhyphenated." This is the same defect at the locality band, and
`constraint-census` currently counts fold failures in the coverage column.

**This spec therefore defines a third state, and only the middle one may license an exclusion:**

```
reachability   we hold the row, the query went to the wrong shelf   → retrieval fix
coverage       the row is genuinely absent from a complete survey   → MAY exclude
fold failure   the row is present under a surface we did not probe  → repair the fold
```

---

## 3. The package

`packages/evidence/` → `@mailwoman/evidence`. The package is pure, has **zero runtime dependencies**,
and performs no I/O.

```
evidence.ts     Observation | Exclusion | Relation | Prior
status.ts       EpistemicStatus + the assertion/score rule
coverage.ts     requireExclusionBasis(cell, fold) — the check
derivation.ts   DerivationGraph + project()
```

Zero dependencies is a requirement. `@mailwoman/bdc`, `@mailwoman/resolver`, `@mailwoman/filer` and
later `@mailwoman/match` all need this package. Routing it through `@mailwoman/core` would add core's
~11 MB of shipped data to every leaf consumer. The same cost is why `nuts-lookup` and
`timezone-lookup` keep local ray-casts today rather than depend on `@mailwoman/spatial`.

**`CoverageBasis` and `supportsExclusion` move here from `@mailwoman/core/layers`, which re-exports
them.** Evidence cannot depend on core. The alternative is for each package to declare its own copy of
the same three strings, which AGENTS.md records as a defect generator: _when two copies must agree,
share the FUNCTION; sharing the constants proves nothing_. The #861 literals matched for the
interface's whole life while the formula diverged. The `layer_coverage` schema and its IO stay in
core. Only the vocabulary and the check move.

**Registration:** a new workspace joins four registers, and only the first produces an error when it
is missing. The four are the root `workspaces` array, `.release-it.json`'s publish list, and **both**
root `tsconfig.json` reference entries (`./packages/evidence` and
`./packages/evidence/tsconfig.test.json`). See AGENTS.md.

### 3.1 The typed union

```ts
type Evidence =
	| { kind: "observation"; source: string; vintage: string; value: unknown }
	| { kind: "exclusion"; source: string; vintage: string; basis: CoverageBasis; scope: CoverageScope }
	| { kind: "relation"; source: string; vintage: string; relationship: string; assertion: Assertion; score?: number }
	| { kind: "prior"; source: string; label: string; weight: number }
```

The type enforces these rules:

- **Observation** — retrieved from a named source at a named vintage. It never carries a score.
- **Exclusion** — proves a candidate impossible. It can be constructed **only** through
  `requireExclusionBasis`, and no public constructor skips the check.
- **Relation** — structural compatibility between entities. It carries `assertion`, and it carries a
  `score` only when `assertion === "inferred"`. This moves `filer.db`'s check constraint into the type
  system.
- **Prior** — changes probability. A prior can never, by itself, prove or exclude.

### 3.2 Two axes, never conflated

`resolution_tier` keeps its current values and its current meaning. The design adds a second field.

|          | `resolution_tier`                                                   | `epistemic_status`                                        |
| -------- | ------------------------------------------------------------------- | --------------------------------------------------------- |
| Question | how was the coordinate produced                                     | what may we claim about it                                |
| Values   | `address_point` `interpolated` `street` `admin` `venue` `plus_code` | `designated` `observed` `derived` `inferred` `unresolved` |
| Today    | present, doing both jobs                                            | **does not exist anywhere in the tree**                   |

A UPRN-matched rooftop is `address_point` + `designated`. An OSM-matched rooftop is `address_point` +
`observed`. The mechanism is the same and the authority differs. Collapsing the two would upgrade a
source's observation into an authority's designation without saying so, and the companion plan
identifies that as the error to avoid.

### 3.3 The check

```
requireExclusionBasis(cell, fold) → Exclusion | null

null when:
  · cell is absent from layer_coverage          unsurveyed — unknown, never absence
  · basis is source_present or null             the source looked ≠ the source found everything
  · the layer carries no manifest               no provenance, no authority
  · the probe's fold ≠ the layer's build fold   §2's fold-failure state
  · the country is outside the probe's scope
```

Only `designated` and `surveyed` pass. **Fold parity is a precondition.** The probe must import the
same fold function the layer's builder used (`foldStreetSurface`, `normalizeLocalityForKey`). The
check takes the fold as an argument, so a mismatch shows up at compile time instead of as an
unreported miss.

### 3.4 Exclusion power: demote only

An exclusion contributes **one negative bit** to the existing `pickByStreetEvidence` fold. It may
reorder siblings. **It never removes a candidate.**

The companion plan's prohibitions permit removal under an explicitly complete coverage scope. This
spec declines that power for the first reduce because of a hazard the plan itself describes. Today the
resolver fails at 10,000 km, and a user notices. An inference engine that fails at 2 km is the failure
mode the plan called worse. Demote-only limits the worst case to the model's own ranking and preserves
the anti-Pelias rule (`street-evidence.ts`, `rerank.ts`): one bit of evidence, never a blended score.

Removal power can be reconsidered once §6's falsifier has a number, and not before.

---

## 4. Four arms

The arms are ordered by what can be built today rather than by expected value.

### 4.1 GB spatial existence — `designated`, ready now

`uprn.db` carries designated coverage and no names, so the GB probe is spatial rather than lexical: _does
any designated address point exist within R of this candidate?_ A candidate landing in a designated
cell with no UPRN inside R warrants one negative bit.

This arm needs no new artifact. `R` is a parameter with a measured default rather than a tuned weight.

### 4.2 US block completeness — `surveyed`, three columns

The US has no designated national address register in public hands. `CoverageBasis.Surveyed` is the
applicable basis, which means the project measures completeness itself against an independent
reference. That reference is Census PL 94-171 table H1, verified as follows:

```
$MAILWOMAN_DATA_ROOT/census/pl2020/ca000022020.pl   152 fields, 669,172 records
  last three fields = H1: 14,392,140 total / 13,475,623 occupied / 916,517 vacant
  matches published CA 2020 figures exactly
```

`packages/tiger/lib/sdk/redistricting.ts` already ingests PL 94-171 into `pl_block`, keyed on the same
15-char GEOID as `tabblock20`, with field offsets "verified against the real files." It reads
**segment 1** (P1 + P2, race). H1 is the tail of **segment 2**. The ingest has run end-to-end at
county scale:

```
tiger-la.db   tabblock20  91,626   pl_block  91,626
tiger-oc.db   tabblock20  26,734   pl_block  26,734
```

This arm therefore needs three columns on `PLBlockTable`, one additional segment read, and a re-run.
`completeness = min(1, address_points_in_block ÷ H1_001N)`, written with `basis: surveyed`.

The data is public domain, so no license check is needed.

### 4.3 `plausibilityCheck` re-expressed — no behaviour change

`filing` → `Observation`. `physical_plant` → `Observation`. `abstain` → the absence of evidence plus
a `coverage_confidence` that already degrades directly. `coverage_confidence` and `block_resolution`
stay the stable public surface of that module.

**The acceptance criterion is that its existing test suite passes unchanged.** This arm ships no new
capability. It shows that the vocabulary accepts any record type, including records that are not geocode results.

### 4.4 FR lexical negative mode — probe-conditional

The measured board cases are concentrated here, but `street-centroids-fr.db` has no `layer_coverage`
at all. Writing one requires answering an empirical question first:

> **Probe:** does BAN's own data support a per-commune designation claim?

Our extract holds 32,539 communes against roughly 34,900 in France, and BAN aggregates per-commune
Base Adresse Locale publications of varying completeness. A blanket `designated` would be false. The
probe's output is a per-commune basis assignment or a decision that BAN supports only
`source_present`, in which case this arm does not ship.

**Do not write coverage for this extract before the probe returns.**

---

## 5. Derivation

`GeocodeResult` gains:

- `epistemic_status: EpistemicStatus` — always present.
- `derivation?: DerivationProjection` — opt-in. It lists each constraint and its contribution.

The graph is **projected from the existing `ResolveNodeTrace`** (#1721) rather than recorded anew.
That recorder already has the three properties this needs, and its tests pin them. Without a sink it
does no bookkeeping and the walk is byte-identical. The per-stage rank vector attributes loss. Every
exit path emits a record, because "an absent record is indistinguishable from a lookup that never
ran."

`resolution_tier` and the response geometry are derived from the projection so they cannot disagree
with the evidence that produced them.

Correlated evidence is represented but never multiplied. Population, road density, POI density and
broadband availability are partial observations of one latent factor, and combining them as
independent likelihoods would overstate confidence.

---

## 6. Falsifiers

Run these before building the arms.

1. **The 187 decomposition.** Of the coverage-class misses on the board, what is the split between
   mis-tag (an exclusion would be correct) and fold failure (an exclusion would be wrong)? The
   denominator is 187, and `mwdev_constraints` already produces the rows. **If fold failures
   dominate, fold repair ships before negative evidence does.** In that case the spec has falsified
   its own first arm, which is the intended outcome.
2. **GB arm on the board.** Compare negative mode on and off, demote-only. The bar is the strata table
   rather than a pooled headline.
3. **Gauntlet 369:** no regression.
4. **`plausibilityCheck` suite:** passes unchanged, which shows §4.3 is lossless.
5. **Trace-off walk:** byte-identical to today. This confirms that the new projection has no effect
   when no sink is attached.

---

## 7. Prohibitions

- **Never emit an inferred point as though retrieved.** `epistemic_status` is mandatory.
- **Soft priors never exclude.** Only a typed `Exclusion` from `requireExclusionBasis` may demote on
  absence.
- **No exclusion without fold parity.** A fold mismatch is a fold failure rather than a coverage fact.
- **Never sum reachability and coverage.** They call for opposite work.
- **A bounded region with stated confidence, never a fabricated coordinate.**
- **Provenance reporting is available in every tier.** Provenance, epistemic status, uncertainty and
  abstention are in the AGPL surface, and no tier hides them.
- **Every assertion keeps its source and license through projection.** Permissively licensed combining
  code does not make the output permissively licensed.

---

## 8. Non-goals

- **Occupancy / vacancy as an address-level layer.** Whether inferred occupancy constitutes personal
  data at the UK/EU granularity is an open question for counsel. Census H1 vacancy is a _published
  block aggregate_ and has a materially different legal position from address-level records. That
  distinction is worth putting to counsel as its own narrow question. Neither ships here.
- **Removal-power exclusions.** Exclusions stay demote-only until §6.2 has a number.
- **Central place theory, naming families, terrain masks.** These belong to later increments of the
  companion plan.
- **`filer_cluster` being empty.** The problem is real but unrelated.

---

## 9. Decisions taken

| Decision        | Choice                                         | Why                                                                       |
| --------------- | ---------------------------------------------- | ------------------------------------------------------------------------- |
| Scope           | negative evidence **and** the derivation shape | an exclusion nobody can see in the result is untrustable                  |
| Exclusion power | demote only, one bit                           | bounds the worst case at the model's own ranking                          |
| Core home       | new `@mailwoman/evidence` workspace            | three consumers, two of them leaf; core's data weight is the blocker      |
| First arm       | GB spatial                                     | the only designated artifact that exists                                  |
| US basis        | `surveyed` rather than `designated`            | no public designated US address register; H1 is the independent reference |
| FR arm          | probe-conditional                              | a blanket per-commune designation claim would be false                    |

## Receipts (2026-09-05)

Task 1 (the falsifier) returned PROCEED on 2026-09-03: 44 of 61 locality-band coverage misses were mis-tags, and 4 were fold failures (#1571). The remaining tasks landed on `main` directly, each after local tests:

| Commit      | What                                                                                             |
| ----------- | ------------------------------------------------------------------------------------------------ |
| `765c33704` | feat(evidence): one vocabulary for what is known and how well it is known                        |
| `64008930c` | feat(evidence): own CoverageBasis, and refuse an exclusion whose fold does not match the layer's |
| `893f87c9f` | refactor(bdc): say plausibility's evidence in the shared vocabulary, same answers                |
| `b033d3faf` | feat(resolver-wof-sqlite): separate uprn's two nulls                                             |
| `690dc28d1` | feat(resolver): let a coverage-licensed absence demote a sibling, never delete one               |
| `1458916f8` | feat(geocode): report what the evidence permits, beside how the coordinate was made              |
| `c9e0cb73a` | feat(evidence): project the derivation from the trace we already record                          |
| `b83600c2b` | feat(tiger): P.L. 94-171 H1 housing counts join pl_block, read from segment 2                    |

Task 10's answer is in `docs/records/evals/2026-09-05-ban-designation-probe.md`. Three items remain open after the plan. `@mailwoman/evidence` is in the release list, but its npm name is unblessed. The FR designated basis waits on the extract carrying `certification_commune`. No address-point lookup stamps a coverage basis yet, so every rooftop reads `observed`.
