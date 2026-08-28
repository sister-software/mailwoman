# Typed evidence and derivation — design spec

**Status:** proposal, not implemented. **Written:** 2026-08-21.
**Public companion:** [`docs/superpowers/plans/2026-08-08-inferential-resolution.md`](../plans/2026-08-08-inferential-resolution.md) — the design record this implements the first slice of.
**Related:** #1571 (inferential resolution), #1685 (coverage basis, landed), #1756 (`parent_fallback_retry` inert).

A pure leaf workspace holding the typed-evidence vocabulary, the epistemic-status axis, the
coverage-basis exclusion gate, and the derivation graph. Plus its first four consumers.

The scope is deliberately narrow. This does not build an inference engine. It makes the evidence the
repository **already has** sayable in one vocabulary, and it wires the one gate that is already built
and has never been called.

---

## 1. Why this exists

### 1.1 Three evidence vocabularies, no shared core

Three packages independently invented a way to say "here is what we know and how well we know it."
None of them can talk to the others.

| Home                                   | Vocabulary                                | Confidence / status axis                                                             |
| -------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------ |
| `packages/bdc/sdk/plausibility.ts`     | `filing` \| `physical_plant` \| `abstain` | `coverage_confidence: high \| low \| insufficient_survey_data`, plus per-axis detail |
| `packages/resolver/street-evidence.ts` | one bit — `hasStreetName`                 | none; fails open unconditionally                                                     |
| `packages/filer/` (`filer.db`)         | `filer_edge.relationship`                 | `assertion: authoritative \| inferred`, with a DB check constraint                   |

`filer.db`'s is the most disciplined of the three, and it is enforced in SQL:

```sql
constraint "filer_family_match_score_inferred_only"
  check (match_score is null or assertion = 'inferred')
```

A score may attach only to an inference. That is the epistemic-status axis, already working, in a
package that has never spoken to either of the others. Measured contents at the 2026-08-07 build:

```
filer_node       45,215      filer_edge  31,605      filer_family  6,929      filer_cluster  0
authoritative    same_entity 18,953 · holding_company 5,752 · subsidiary 2,894
                 superseded_by 2,826 · management_company 812
inferred         parent_company 368 …
```

Three independent implementations of the same idea is the signal AGENTS.md describes: not "nobody
found the shared tool" but "there was no shared tool to find."

### 1.2 The gate is built and has never been called

#1685 landed `CoverageBasis` and `supportsExclusion()` in `packages/core/layers/`. A grep for
consumers finds the definition and its own unit test, and nothing else.

One layer has already earned the right to use it:

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
            NO layer_coverage table at all — predates the contract
```

So the blocking condition is not a missing layer. It is an unwired one.

### 1.3 The positive half is built and measured

`packages/resolver/street-evidence.ts` (#727 phase 4c) is the positive counterpart, with a receipt:
**+6.0 pp street@1 (0.791 → 0.851), 96 fixes / 3 breaks, 32:1**, the value concentrated on the FR
date-name class. Its docstring states the exact assumption that designated coverage retires:

> POSITIVE EVIDENCE ONLY: the ABSENCE of a name is never evidence against a parse **(index
> incompleteness is the default state of the world)**, so the policy always fails open.

The parenthetical is true in general and false inside a `designated` cell. The negative half is
therefore a coverage-qualified mode on an interface that already exists, not a new subsystem.

---

## 2. The three states — reachability, coverage, fold failure

`packages/dev-mcp/constraint-census.ts` already separates two of the three, and its own docstring
states why they must never be summed: a key held in another band is a retrieval fix, a key held
nowhere is a data fact, and both reach a caller as `null`.

Run over the full board (591 rows), production defaults:

```
591 rows → 1,609 backend lookups; 306 resolved nothing (19.0%)
  key exists in another band :  119   ← reachability, a retrieval fix
  key exists nowhere         :  187   ← coverage, a data fact
  by band                    :  locality 96 · postalcode 80 · region 11
  INERT                      :  parent_fallback_retry (196 firings, 196 nothing, 0 conversions) — #1756
```

Reading the 96 locality-band rows is what this spec turns on. They are **not one class**:

| Class                                                                                                                                                                                                   | Rows       | Would an exclusion be correct?                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | --------------------------------------------------------------------- |
| Street fragment mis-tagged `locality` — `locality=Avenida` ← `Avenida Corrientes`; `locality=de Catalunya` ← `Rambla de Catalunya`; `locality=Turner St` ← `…Garrod Building, Turner St, London E1 2AD` | many       | **Yes.** Same shape as the FR date-name class that earned the +6.0 pp |
| POI mis-tagged `locality` — `locality=Statue of Liberty`; `locality=Great Mosque of Niamey`                                                                                                             | some       | Yes; poi.db may also hold them                                        |
| Junk span — `locality=New` ← `New Territories, Hong Kong`; `locality=near NAFTI`                                                                                                                        | few        | Yes                                                                   |
| **Fold / surface-form miss** — `locality=Tel Aviv-Yafo`; `locality=São Paulo - SP`; `locality=Co. Westmeath`; `locality=ХУД - 15 хороо`                                                                 | unmeasured | **No. This is the trap.**                                             |

Those last rows name real places. `Tel Aviv-Yafo` exists. `São Paulo - SP` exists with the state
suffix stripped. The key "exists nowhere" **only under the fold we probed with**. An exclusion fires
on them and is confidently wrong, and at the decision point it is indistinguishable from a true
absence.

`street-evidence.ts` already carries this scar one layer down — "the 4 v1-policy breaks were fold
mismatches: `pillet-will` stored unhyphenated." This is the same defect at the locality band, and
`constraint-census` currently counts fold failures in the coverage column.

**Therefore a third state is named, and only the middle one may license an exclusion:**

```
reachability   we hold the row, the query went to the wrong shelf   → retrieval fix
coverage       the row is genuinely absent from a complete survey   → MAY exclude
fold failure   the row is present under a surface we did not probe  → repair the fold
```

---

## 3. The package

`packages/evidence/` → `@mailwoman/evidence`. Pure, **zero runtime dependencies**, no I/O.

```
evidence.ts     Observation | Exclusion | Relation | Prior
status.ts       EpistemicStatus + the assertion/score rule
coverage.ts     requireExclusionBasis(cell, fold) — the gate
derivation.ts   DerivationGraph + project()
```

Zero deps is required rather than tidy. `@mailwoman/bdc`, `@mailwoman/resolver`,
`@mailwoman/filer` and later `@mailwoman/match` all need this. Routing it through `@mailwoman/core`
would drag core's ~11 MB of shipped data behind every leaf consumer — the same cost that makes
`nuts-lookup` and `timezone-lookup` keep local ray-casts today rather than depend on
`@mailwoman/spatial`.

**`CoverageBasis` and `supportsExclusion` MOVE here from `@mailwoman/core/layers`, which re-exports
them.** Evidence cannot depend on core, and the alternative — each declaring its own copy of the same
three strings — is the arrangement AGENTS.md records as a defect generator: _when two copies must
agree, share the FUNCTION; sharing the constants proves nothing_. The #861 literals matched for the
contract's whole life while the formula diverged. The `layer_coverage` schema and its IO stay in
core; only the vocabulary and the gate move.

**Registration:** a new workspace joins four registers, and only the first fails loudly — the root
`workspaces` array, `.release-it.json`'s publish list, and **both** root `tsconfig.json` reference
entries (`./packages/evidence` and `./packages/evidence/tsconfig.test.json`). See AGENTS.md.

### 3.1 The typed union

```ts
type Evidence =
	| { kind: "observation"; source: string; vintage: string; value: unknown }
	| { kind: "exclusion"; source: string; vintage: string; basis: CoverageBasis; scope: CoverageScope }
	| { kind: "relation"; source: string; vintage: string; relationship: string; assertion: Assertion; score?: number }
	| { kind: "prior"; source: string; label: string; weight: number }
```

The rules that make it worth having a type at all:

- **Observation** — retrieved from a named source at a named vintage. Never carries a score.
- **Exclusion** — proves a candidate impossible. Constructible **only** through
  `requireExclusionBasis`; there is no public constructor that skips the gate.
- **Relation** — structural compatibility between entities. Carries `assertion`, and a `score` only
  when `assertion === "inferred"` — `filer.db`'s check constraint, lifted into the type system.
- **Prior** — changes probability. Can never, by itself, prove or exclude.

### 3.2 Two axes, never conflated

`resolution_tier` keeps its current values and its current meaning. A second field is added.

|          | `resolution_tier`                                                   | `epistemic_status`                                        |
| -------- | ------------------------------------------------------------------- | --------------------------------------------------------- |
| Question | how was the coordinate produced                                     | what may we claim about it                                |
| Values   | `address_point` `interpolated` `street` `admin` `venue` `plus_code` | `designated` `observed` `derived` `inferred` `unresolved` |
| Today    | present, doing both jobs                                            | **does not exist anywhere in the tree**                   |

A UPRN-matched rooftop is `address_point` + `designated`. An OSM-matched rooftop is `address_point` +
`observed` — same mechanism, different authority. Collapsing them silently upgrades a source's
observation into an authority's designation, which the companion plan names as the error to avoid.

### 3.3 The gate

```
requireExclusionBasis(cell, fold) → Exclusion | null

null when:
  · cell is absent from layer_coverage          unsurveyed — unknown, never absence
  · basis is source_present or null             the source looked ≠ the source found everything
  · the layer carries no manifest               no provenance, no authority
  · the probe's fold ≠ the layer's build fold   §2's fold-failure state
  · the country is outside the probe's scope
```

Only `designated` and `surveyed` pass. **Fold parity is a precondition, not a footnote:** the probe
must import the same fold function the layer's builder wrote (`foldStreetSurface`,
`normalizeLocalityForKey`), and the gate takes it as an argument so a mismatch is a compile-time
concern rather than a silent miss.

### 3.4 Exclusion power: demote only

An exclusion contributes **one negative bit** to the existing `pickByStreetEvidence` fold. It may
reorder siblings. **It never removes a candidate.**

The companion plan's prohibitions permit removal under an explicitly complete coverage scope. This
spec declines that power for the first cut. The reason is the plan's own hazard: today the resolver
fails at 10,000 km and a user notices; an inference engine that fails at 2 km is the failure mode we
called worse. Demote-only bounds the worst case at the model's own ranking and preserves the
anti-Pelias rule (`street-evidence.ts`, `rerank.ts`): one bit of evidence, never a blended score.

Removal power is revisitable once §6's falsifier has a number, and not before.

---

## 4. Four arms

Ordered by what is buildable today, not by expected value.

### 4.1 GB spatial existence — `designated`, ready now

`uprn.db` carries designated coverage and no names, so the GB probe is spatial, not lexical: _does
any designated address point exist within R of this candidate?_ A candidate landing in a designated
cell with no UPRN inside R earns one negative bit.

No new artifact. `R` is a parameter with a measured default, not a tuned weight.

### 4.2 US block completeness — `surveyed`, three columns

The US has no designated national address register in public hands. `CoverageBasis.Surveyed` is the
applicable basis, and it is defined as measuring completeness ourselves against an independent
reference. That reference is Census PL 94-171 table H1, verified:

```
/mnt/playpen/mailwoman-data/census/pl2020/ca000022020.pl   152 fields, 669,172 records
  last three fields = H1: 14,392,140 total / 13,475,623 occupied / 916,517 vacant
  matches published CA 2020 figures exactly
```

`packages/tiger/sdk/redistricting.ts` already ingests PL 94-171 into `pl_block`, keyed on the same
15-char GEOID as `tabblock20`, with field offsets "verified against the real files." It reads
**segment 1** (P1 + P2, race). H1 is the tail of **segment 2**. Proven end-to-end at county scale:

```
tiger-la.db   tabblock20  91,626   pl_block  91,626
tiger-oc.db   tabblock20  26,734   pl_block  26,734
```

So this arm is: three columns on `PLBlockTable`, one additional segment read, a re-run.
`completeness = min(1, address_points_in_block ÷ H1_001N)`, written with `basis: surveyed`.

Public domain. No licence gate.

### 4.3 `plausibilityCheck` re-expressed — no behaviour change

`filing` → `Observation`; `physical_plant` → `Observation`; `abstain` → the absence of evidence plus
a `coverage_confidence` that already degrades honestly. `coverage_confidence` and `block_resolution`
stay the stable public surface of that module.

**Acceptance is that its existing test suite passes unchanged.** This arm ships no new capability;
it exists to prove the vocabulary is claim-type-agnostic rather than geocode-shaped.

### 4.4 FR lexical negative mode — probe-gated

The measured board lives here, but `street-centroids-fr.db` has no `layer_coverage` at all. Writing
one requires answering a question first, and the question is empirical:

> **Probe:** does BAN's own data support a per-commune designation claim?

Our shard holds 32,539 communes against roughly 34,900 in France, and BAN aggregates per-commune
Base Adresse Locale publications of varying completeness. A blanket `designated` would be false. The
probe's output is a per-commune basis assignment or a decision that BAN supports only
`source_present`, in which case this arm does not ship.

**Do not write coverage for this shard before the probe returns.**

---

## 5. Derivation

`GeocodeResult` gains:

- `epistemic_status: EpistemicStatus` — always present.
- `derivation?: DerivationProjection` — opt-in, naming each constraint and its contribution.

The graph is **projected from the existing `ResolveNodeTrace`** (#1721), not newly recorded. That
recorder already has the three properties this needs, and its tests pin them: no sink means no
bookkeeping and a byte-identical walk; the per-stage rank vector attributes loss; every exit path
emits, because "an absent record is indistinguishable from a lookup that never ran."

`resolution_tier` and the response geometry are derived from the projection so they cannot disagree
with the evidence that produced them.

Correlated evidence is represented, never multiplied: population, road density, POI density and
broadband availability are partial observations of one latent factor, and combining them as
independent likelihoods manufactures confidence.

---

## 6. Falsifiers

Run before building the arms, not after.

1. **The 187 decomposition.** Of the coverage-class misses on the board, what is the split between
   mis-tag (an exclusion would be correct) and fold failure (an exclusion would be wrong)? The
   denominator is 187 and `mwdev_constraints` already produces the rows. **If fold failures
   dominate, fold repair ships before negative evidence does** — and this spec has falsified its own
   first arm, which is the intended outcome in that case.
2. **GB arm on the board.** Negative mode on vs off, demote-only. Bar is the strata table, not a
   pooled headline.
3. **Gauntlet 369:** no regression.
4. **`plausibilityCheck` suite:** passes unchanged, proving §4.3 is lossless.
5. **Trace-off walk:** byte-identical to today, pinning "no sink, no effect" through the new
   projection.

---

## 7. Prohibitions

- **Never emit an inferred point as though retrieved.** `epistemic_status` is mandatory, not optional
  decoration.
- **Soft priors never exclude.** Only a typed `Exclusion` from `requireExclusionBasis` may demote on
  absence.
- **No exclusion without fold parity.** A fold mismatch is a fold failure, not a coverage fact.
- **Never sum reachability and coverage.** They call for opposite work.
- **A bounded region with stated confidence, never a fabricated coordinate.**
- **Honesty is not a premium feature.** Provenance, epistemic status, uncertainty and abstention are
  in the AGPL surface. No tier hides them.
- **Every assertion keeps its source and licence through projection.** A permissive output is not
  earned by permissive combining code.

---

## 8. Non-goals

- **Occupancy / vacancy as an address-level layer.** Whether inferred occupancy constitutes personal
  data at the UK/EU granularity is an open question for counsel. Census H1 vacancy is a _published
  block aggregate_ and has a materially different posture from address-level records; that
  distinction is worth putting to counsel as its own narrow question, and neither ships here.
- **Removal-power exclusions.** Demote-only until §6.2 has a number.
- **Central place theory, naming families, terrain masks.** Companion plan, later slices.
- **`filer_cluster` being empty.** Real, unrelated.

---

## 9. Decisions taken

| Decision        | Choice                                         | Why                                                                       |
| --------------- | ---------------------------------------------- | ------------------------------------------------------------------------- |
| Scope           | negative evidence **and** the derivation shape | an exclusion nobody can see in the result is untrustable                  |
| Exclusion power | demote only, one bit                           | bounds the worst case at the model's own ranking                          |
| Core home       | new `@mailwoman/evidence` workspace            | three consumers, two of them leaf; core's data weight is the blocker      |
| First arm       | GB spatial                                     | the only designated artifact that exists                                  |
| US basis        | `surveyed`, not `designated`                   | no public designated US address register; H1 is the independent reference |
| FR arm          | probe-gated                                    | a blanket per-commune designation claim would be false                    |
