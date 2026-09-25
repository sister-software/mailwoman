# Geographic-model boundaries and the pharmacy first increment

**Date:** 2026-08-26 · **Status:** design of record; the first increment has since landed · **Issue:** #1917 ·
**Epic:** #1916 (program parent #1680) · **Companions:** #1683 (empirical activity-affordance
vector), #1928 (the semantic-utility probe this record supplies a target for).

**Amendments:** [§4.1 — mapping-breadth wave 1](#41-amendment-1-mapping-breadth-wave-1-2026-08-27)
(2026-08-27, #1961; authored 2026-08-27 by #1963 — W1-1 and W1-2 landed, W1-3 held for #1980, see the
closing note). **Companion decision:**
[the semantic-route integration decision](./2026-08-27-semantic-route-integration-decision.md)
(2026-08-27, #1966) — stop condition 2, answered; §6's `@mailwoman/core` exclusion left standing.

This record does two things. It **identifies the current owner** of every boundary the world-model
program would otherwise re-create, each against a path that exists on HEAD. It also **freezes one
end-to-end increment**, `pharmacy affords obtain_medication`, so that every later issue in the program
is judged against a fixed target.

This record created no package. `@mailwoman/geographic-model` appeared throughout as a **recorded
ownership boundary** rather than a workspace. The issue that scaffolded it inherited the
responsibilities listed in §3 and nothing beyond them.

> **Corrected 2026-08-27 (#1961).** The workspace now exists at `packages/geographic-model/`. It is
> in the root `workspaces` array (58 entries) and in `.release-it.json`'s publish list (52 of those
> 58). Its `package.json` reads `version: 0.0.0` and carries no `private` flag. §3's ownership row is
> updated to match. The package's existence does not change what it owns and must not own.

---

## 1. Why an inventory comes first

The repository already holds a POI category vocabulary, a phrase→category lexicon, a POI intent and
execution path, a per-cell coverage interface with an exclusion predicate, a committed POI board, and
a mechanism-account vocabulary. A semantic layer could easily duplicate any of those boundaries. Two of
them (`@mailwoman/poi-taxonomy`, `@mailwoman/core/layers`) are close enough to "world knowledge" that
an implementer could grow one into a general ontology without noticing the decision.

This record therefore guards against **a second copy of an existing boundary, or world semantics
landing inside `@mailwoman/core`**, rather than against a missing design. The inventory below makes
that visible at review time. If a change proposes a concept, a mapping, or a coverage rule, §2 says who
already owns the nearest thing, and §3 says whether the new work belongs there.

---

## 2. Boundary inventory against HEAD

Every path in this section was read at the commit this record was written against.

### 2.1 POI categories — `@mailwoman/poi-taxonomy`

| What                                | Where                                                                                                                                        |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Category record + branded id        | `packages/poi-taxonomy/lib/types.ts` (`CategoryRecord`, `POICategoryID`, `CategorySource`)                                                   |
| Authored curated layer              | `packages/poi-taxonomy/data/curated-overlay.json` — 26 category records, 55 synonym phrases                                                  |
| External snapshot                   | `packages/poi-taxonomy/data/overture-categories.csv` — Overture schema `v1.17.0`, CDLA-Permissive-2.0                                        |
| Generated, committed merge          | `packages/poi-taxonomy/data/taxonomy.json` — 2,113 categories, 55 synonyms; **do not hand-edit**                                             |
| Provenance + regeneration procedure | `packages/poi-taxonomy/data/PROVENANCE.md`                                                                                                   |
| Matching core                       | `packages/poi-taxonomy/lib/lookup-core.ts` (`createLookupCore`, `lookupPOICategory`, `requiresBuildLocalLayer`, `resolveOvertureCategories`) |

Three structures exist over categories, and none of them is a relation in the sense this program
needs:

1. **`CategoryRecord.hierarchy`** — ordered ancestry, top level first, ending with the category's own
   id. It is **containment within one vocabulary**, authored by Overture. `pharmacy` reads
   `health_and_medical > pharmacy`; `drugstore` reads `retail > drugstore`.
2. **`CategoryRecord.overtureCategories`** — a **namespace translation**, curated seed id → the
   Overture `taxonomy.primary` leaf ids a built `poi.db` stores. Six of 2,113 categories
   declare one (`bank`, `cafe`, `place_of_worship`, `school`, `supermarket`, `trail`). Absent means
   identity: the seed id is its own probe id.
3. **`SynonymEntry`** — one phrase, **one** `categoryID`, optionally locale-hinted
   (`packages/poi-taxonomy/lib/types.ts`). The cardinality matters here: the field is a single id, so a
   phrase can never refer to a set.

This package has no relation type, modality, country scope, or per-assertion provenance. Its
provenance is per file (`PROVENANCE.md`), which is the right grain for a vocabulary snapshot and the
wrong grain for a derived fact.

### 2.2 World semantics — unowned on HEAD

Nothing in the repository expresses `A affords X`, or any other non-taxonomic relation between a place
kind and something a person does there. The nearest structures are the three in §2.1, and none of them
fits. Containment and namespace translation are different relations from affordance, and a
single-valued synonym cannot hold a set. The program fills this gap, and §3 assigns it.

### 2.3 Coverage epistemics — `@mailwoman/core/layers`

| What                                 | Where                                                                                                              |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Interface tables + DDL               | `packages/core/lib/layers/schema.ts` (`LayerManifestTable`, `LayerCoverageTable`, `LayerTier`, `CoverageBasis`)    |
| Parsed face + read/write + the check | `packages/core/lib/layers/manifest.ts` (`LayerManifest`, `CoverageCell`, `supportsExclusion`, `readLayerCoverage`) |
| Barrel                               | `packages/core/lib/layers/index.ts`                                                                                |
| Interface prose for layer authors    | `docs/engineering/reference/layer-interface.mdx`                                                                   |
| Cell-vs-scope coverage design        | `docs/superpowers/specs/2026-08-11-coverage-register-design.md`                                                    |

`supportsExclusion(cell)` returns true only for `CoverageBasis.Designated` or
`CoverageBasis.Surveyed`. `CoverageBasis.SourcePresent` supports presence and nothing else, because a
source that looked has not necessarily found everything. A missing `layer_coverage` row means
unmapped, never surveyed-and-empty.

**Measured against the shipped layer** (`poi.db`, manifest `name: poi`, `version: 2026-07-22.0`,
`tier: shipped`, `source: overture-places`, `source_vintage: 2026-07-22.0`): 158,813 coverage cells,
**every one at `basis = source_present`**, with `completeness` min and max both `1.0`. The writer
documents this. `packages/mailwoman/lib/gazetteer-pipeline/poi/build-poi.ts` sets
`basis: CoverageBasis.SourcePresent` on both the rows-derived and the override coverage sets, with a
comment stating that the `1.0` means "Overture returned rows here" rather than "everything here is known".

This constrains the increment in §4: **`supportsExclusion` is false for every cell of the shipped POI
layer today.** Any coverage-aware negative fact the program authors therefore has no effect against
`poi.db` until that register is rebuilt with an earned basis. That behavior is correct and should not
be worked around. It is also why the increment states the coverage rule as a check rather than as a
capability.

### 2.4 Execution — the runtime POI branch

| Stage                         | Where                                                                                                                        |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Subject/anchor split          | `packages/kind-classifier/lib/poi.ts` (`matchPOISubject`, `createScorePOIQuery`, `createScorePOICategory`)                   |
| Lexicon adapter + stage build | `packages/mailwoman/lib/poi-intent.ts` (`poiTaxonomyLookup`, `createPOIIntentStage`)                                         |
| Intent execution              | `packages/mailwoman/lib/poi-executor.ts` (`createPOIExecutor`)                                                               |
| Backend probe                 | `packages/resolver-wof-sqlite/lib/poi-lookup.ts` (`POILookup.search`, `#searchKRing`)                                        |
| Wiring                        | `packages/mailwoman/lib/runtime-pipeline.ts` (`poiQueryKind`, default-on)                                                    |
| Interface types               | `packages/core/lib/pipeline/types.ts` (`POIIntent`, `POIResult`, `POIIntentOutcome`)                                         |
| Layer build                   | `packages/mailwoman/lib/gazetteer-pipeline/poi/build-poi.ts`                                                                 |
| Committed board + fixtures    | `packages/mailwoman/lib/eval-harness/poi-board.ts`, `packages/mailwoman/lib/eval-harness/fixtures/poi-board.jsonl` (51 rows) |

The path runs in three steps:

1. `matchPOISubject` splits the input at the first anchor separator whose prefix hits the injected
   lexicon (subject ≤ 8 tokens).
2. `poiTaxonomyLookup` probes the exact phrase, then a small English singularization, then the
   locale-normalized form, then a one-edit typo, then brand, then regional brand alias.
3. The executor resolves an anchor center and probes `poi.db` over
   `resolveOvertureCategories(subject.categoryID)`, re-tagging every hit back to the canonical seed id.

Two properties of that path matter to §5. The lexicon probe is **positive evidence only**. On a miss
it returns `[]`, `matchPOISubject` returns `null`, `createScorePOIQuery` returns `0`, and the input
never takes the POI branch at all. The backend probe is **exact set membership** over Overture leaf
ids. `#searchKRing` resolves each seed id through `poi_category_codes` and drops ids the layer does not
carry without reporting them.

The abstain vocabulary is small and already structured: `POIIntentOutcome` is
`{ type: "intent"; intent; results? }` or `{ type: "abstain"; reason }`, with
`requires_build_local_layer` and `anchor_required` as the two reasons the executor emits.

### 2.5 Learned decoding and ranking — `@mailwoman/neural`, `@mailwoman/core/decoder`, `@mailwoman/resolver`

| What                           | Where                                                                                                                                        |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Decode-time grammar + tree     | `packages/core/lib/decoder/` (`build-tree.ts`, `validate-tree.ts`, `types.ts`)                                                               |
| Grammar interface              | `docs/engineering/reference/decoder-grammar.mdx`                                                                                             |
| Inference + decode-time priors | `packages/neural/` (`scorer.ts`, `viterbi.ts`, `semi-markov-decode.ts`, `placetype-pair-prior.ts`, `fst-prior.ts`, `gazetteer-inference.ts`) |
| Candidate ordering             | `packages/resolver/lib/toponym-prior.ts` (`rankByImportance`), `packages/resolver/lib/admin-containment.ts`                                  |

The program must not reach into this boundary. The standing rule is that registries are soft priors
supplying **positive evidence only**, and the decoder grammar interface states which terms the shipped
decoder maximizes. A world-model record that emitted a boost, a penalty, or a candidate order would
hand-author policy in the one place where the system is supposed to learn it.

### 2.6 Measurement surfaces that already exist

| Surface                                                           | Where                                                                      |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------- |
| POI query board (assembled-answer grading, pre-registered floors) | `packages/mailwoman/lib/eval-harness/poi-board.ts`                         |
| Gauntlet cases                                                    | `packages/mailwoman/lib/eval-harness/gauntlet/`                            |
| Warm-engine measuring tools                                       | `packages/dev-mcp/lib/tools/`                                              |
| Mechanism-account shapes                                          | `packages/dev-mcp/lib/diagnose.ts` (`DIAGNOSE_SHAPES`, `SHAPE_PREDICATES`) |
| Diagnosis conventions                                             | `docs/superpowers/specs/2026-08-17-mechanism-accounts.md`                  |
| Conformance-law fixture interface (#1918)                         | `packages/mailwoman/lib/eval-harness/conformance/`                         |
| Law-suite register (what a default run covers)                    | `packages/mailwoman/lib/eval-harness/conformance/suites.ts`                |
| Law-suite runner (`mailwoman eval conformance`)                   | `packages/mailwoman/lib/eval-harness/conformance/command.ts`               |

**Updated 2026-08-27 (#1961).** When this record was written the register held two laws, case folding
(#1919) and whitespace (#1920). `CONFORMANCE_SUITES` holds **five** on HEAD, each a `{ts,jsonl}` pair
in that directory: `case-folding`, `whitespace`, `punctuation`, `nfc-nfd` (the canonical-form law) and
`refinement-monotonicity`. The last of those reads the resolver's own candidate tables through
`packages/mailwoman/lib/eval-harness/conformance/candidate-admissibility.ts` (#1923), which is a set of
candidate accounts rather than a sixth suite. The paragraph below describes the fixture interface, and
it is unchanged.

A law suite plugs into the conformance module. A fixture specifies a base query, one context, a
variant query, a law, one of five closed outcome comparators, and the relation the two outcomes must
satisfy. A row also carries a `status`. `pass` checks the run, and `known_fail` / `improvement_target`
report without blocking. This follows the Gauntlet regression layer's three-way reading: a violated
row is tracked rather than deleted, and it is never re-stated as `expect: diverges`, which would make
the suite assert the defect. Each law declares an applicability interface beside its transformations.
When a row lacks an arm, the row records the rule that refuses it, so the arm is not silently missing.
Case folding excludes a locale-conditional casing (Turkish dotted/dotless `i`), and whitespace excludes
a space that belongs to a structured identifier (`N7 0BT`). The module's `mechanism_shape` comparator
reads the `DIAGNOSE_SHAPES` vocabulary in the row above but does not import it. `@mailwoman/dev-mcp`
depends on `mailwoman`, so the labels arrive as an observer's output rather than as a second copy of
the vocabulary.

#1928 will run into one limit. `DIAGNOSE_SHAPES` is a vocabulary of **address-path** mechanism states:
parse, evidence, retrieval, ranking, and outcome. It contains no state for the POI branch, such as a
subject-match state or an abstain-reason state. The POI branch's own structured vocabulary is
`POIIntentOutcome` plus the board's `POIBoardExpect["kind"]`. A probe that pre-registers a
`baselineFailureShape` for a POI query must use one of those or deliberately extend the
mechanism-account vocabulary. An address-path shape has no meaning for a POI query.

---

## 3. The package boundary

| Owner                                                             | Owns                                                                                                                                                                                                                                                                     | Must not own                                                                                                         |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `@mailwoman/poi-taxonomy`                                         | External and curated POI category vocabulary; category hierarchy; the Overture-leaf translation; query phrase → category lexicon; brands                                                                                                                                 | Relations other than containment; activities; affordances; per-assertion provenance                                  |
| `@mailwoman/geographic-model` (`packages/geographic-model/`)      | Stable concepts beyond the POI vocabulary; relation definitions; activities and affordances; rule modality; source observations; derived facts; derivation provenance; deterministic compilation and validation; mappings from external vocabularies into world concepts | Ranking weights, boosts, penalties, or any candidate-ordering API; a second POI taxonomy; a second coverage register |
| `@mailwoman/core/layers`                                          | Dataset identity (`layer_manifest`); coverage epistemics (`layer_coverage`, `CoverageBasis`, `supportsExclusion`)                                                                                                                                                        | World semantics of any kind                                                                                          |
| Mailwoman runtime / resolver                                      | Candidate lookup, anchor resolution, POI execution, and the join of candidates with layer evidence and (later) world facts; candidate ordering                                                                                                                           | Authored world knowledge                                                                                             |
| Learned decoding (`@mailwoman/neural`, `@mailwoman/core/decoder`) | Interpretation of observations; the decode objective                                                                                                                                                                                                                     | Authored imperatives that bypass interpretation                                                                      |
| #1683                                                             | Empirical, spatial activity-affordance statistics fitted from data                                                                                                                                                                                                       | The stable activity/affordance identifiers themselves — those come from the geographic model                         |

The following dependency rules are required:

- **`@mailwoman/core` must not depend on `@mailwoman/geographic-model`** without a later integration
  decision that demonstrates the direction is necessary. Core ships the pipeline interface and ~9 MB of
  reference data to every consumer. A world-semantics dependency in core would be inherited by every
  drop-in API, whether or not it needs one.
- **The geographic model and #1683 share identifiers rather than statistics.** The geographic model owns
  `obtain_medication` as a stable identifier with provenance, and #1683 owns whatever numbers get
  fitted against it. Neither re-declares the other's half. This split keeps an authored relationship
  from gradually becoming a weight.
- **The ownership row states a category of record rather than a license to author freely** (added
  2026-08-27, #1961). The compiled model may carry only the concepts, activities, assertions and
  mappings in the frozen set in §4, plus whatever an amendment admits. Today that is §4.1's wave-1 set
  and nothing else. A record outside both would widen this table without review, which stop
  condition 5 refuses.

One rule governs the whole boundary: **knowledge creates observations and never overrides learned
interpretation.** A world-model record may create a fact, an anomaly, a contradiction, or a
coverage-qualified absence. It may not create an imperative.

---

## 4. The frozen increment

This block is copied verbatim from #1917. Every Phase B–F issue in the program is judged against it,
and any change to it must be an explicit amendment to this record.

```text
entity kind: pharmacy
activity: obtain_medication
external vocabulary: @mailwoman/poi-taxonomy pharmacy
world relation: affords
semantic proposition: pharmacy affords obtain_medication
coverage rule: absence is negative evidence only when supportsExclusion(...) permits it
ranking behavior: unchanged
```

Each line constrains the increment as follows:

- **entity kind: `pharmacy`** — the only establishment class the first increment requires. No sibling
  class is added to make the proposition read better.
- **activity: `obtain_medication`** — the only activity. It is an identifier the geographic model
  owns. #1683 may later fit statistics against it, and this record does not.
- **external vocabulary** — the mapping target is the category with id **`pharmacy`** (a
  `POICategoryID`), record `{ id: "pharmacy", label: "Pharmacy", hierarchy: ["health_and_medical",
"pharmacy"], basicLabel: "Pharmacy", osmTag: "amenity=pharmacy", source: "overture" }`, authored in
  `packages/poi-taxonomy/data/curated-overlay.json` and emitted into
  `packages/poi-taxonomy/data/taxonomy.json`. The category declares no `overtureCategories`, so
  `resolveOvertureCategories("pharmacy")` is the identity `["pharmacy"]`.
- **world relation: `affords`** — the only non-taxonomic relation. `isa`, `partOf`, and any other
  relation stay undefined until an executable need requires one.
- **coverage rule** — a missing expected observation becomes negative evidence only where
  `supportsExclusion(...)` from `packages/core/lib/layers/manifest.ts` permits it. As measured in §2.3,
  that permits nothing against today's `poi.db`. The rule is written as a check so the first increment
  cannot accidentally ship an exclusion the data does not support.
- **ranking behavior: unchanged** — no ordering, score term, boost, or penalty changes anywhere in
  `packages/resolver/` or `packages/neural/` as a consequence of this increment. The first production
  integration is diagnostic and observational only.

The following are explicitly deferred, even where they would be convenient during implementation: roads, utilities and electrification,
population context, environmental statistics, water/land compatibility, mapping breadth beyond the one
category above **and §4.1's wave-1 set**, and any production decoder integration.

### 4.1 Amendment 1: mapping-breadth wave 1 (2026-08-27)

**Issue:** #1961 · **Permitted by:** #1930's recorded GO · **Required by:** stop condition 5 ·
**Authored by:** #1963 (the semantics) — the query-phrase surface is #1962's and is not admitted here.

§4 froze one proposition. #1930 recorded GO, which allows mapping breadth to be _proposed_. Stop
condition 5 requires the boundary to be widened here, in a reviewed change, before a record is authored
against it. This section is that widening, and it is exhaustive. #1963 may author only what the admitted
table lists. A later entry must arrive as amendment 2 rather than as an extra row in the data.

Stop condition 4 applies to every admitted row individually. Each row cites an attested target: a
committed record, a measured gap with its receipt, or a filed defect with a reproduction. Candidates
that had only a plausible use are in the excluded table with the reason. That table is deliberately
longer than the admitted one.

#### What wave 1 admits

Wave 1 admits three records and one vocabulary correction. All three records concern the activity §4
already froze, and wave 1 adds no activity.

| Entry    | Record                                                                                      | Country scope                                     | Attested target                                                                                                                                                                                                                                                                                                                                                              |
| -------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **W1-1** | `ConceptRecord` `drugstore` — `kind: establishment`, `isA: ["establishment"]`               | none on the concept; the claim in W1-2 carries it | §5.3's measured recall gap: **7,168 of the 89,336** rows under the two pharmacy-adjacent leaves sit under `retail > drugstore` and are structurally out of reach of the shipped `pharmacy` query — 8.0% overall, 12.9% within the US — measured on `poi.db` manifest `2026-07-22.0`                                                                                          |
| **W1-2** | `RelationAssertion` on W1-1: `affords` → `obtain_medication`, `modality: strongly_expected` | `["US"]`                                          | The committed curator statement in `packages/poi-taxonomy/data/curated-overlay.json`: `{ "phrase": "drugstore", "categoryID": "pharmacy", "locales": ["en-US"] }` — already in the repository, and it says that in en-US this class refers to the pharmacy category. Together with the US half of the §5.3 count, **6,679 of the 7,168**                                     |
| **W1-3** | `ExternalMappingRecord` `drugstore` → `poi-taxonomy` external id `drugstore`                | none                                              | Same measured gap as W1-1, plus a read-back verified on HEAD: `getPOICategory("drugstore")` returns `{ id: "drugstore", label: "Drugstore", hierarchy: ["retail", "drugstore"], source: "overture" }` at table version `0.4.0`, Overture release `v1.17.0`. It declares no `overtureCategories`, so `resolveOvertureCategories("drugstore")` is the identity `["drugstore"]` |

Together, W1-1 to W1-3 form the multi-target affording set §5.3 asked for, and **the schema already
expresses it without a new field**: one activity, two establishment concepts, and one mapping and one
assertion for each concept. `ExternalMappingRecord` gains nothing multi-valued. No field states a
preference between `pharmacy` and `drugstore`, because the schema has no field for one.

`drugstore` is a kind of `establishment` **directly** rather than of `healthcare_facility`, for three
reasons. The external hierarchy puts it under `retail`, disjoint from `health_and_medical`.
`healthcare_facility` is defined as premises that exist to provide healthcare, and a retail premises
with a dispensing counter falls outside that definition. Placing it there would also give every later healthcare
class a retail ancestor.

#### The one vocabulary correction: `affords` becomes defeasible

W1-2 cannot be `necessary`. The attested material says a US drugstore characteristically dispenses. It
does not say every premises under `retail > drugstore` does, and neither a locale-scoped synonym nor a
row count is a census of dispensing. The evidence supports `strongly_expected`.

Under the `affords` relation as §4 froze it, that modality has no defined reading.
`RelationSemantics.Hard` means an exception is a defect in the record set, a claim that only
`necessary` and `prohibited` make. Admitting W1-2 therefore requires the relation record in
`packages/geographic-model/data/model/relations.json` to read `semantics: "defeasible"`, and this
amendment admits that change. The change has three consequences:

- **The pharmacy claim's strength stays the same.** `Modality.Necessary` is a per-record claim: it
  holds in every instance, and a counter-example falsifies the record rather than qualifying it. It
  stays on the pharmacy assertion unchanged. The change is to the relation-level statement about
  whether this relation's assertions admit exceptions at all. That change lets a `strongly_expected`
  record sit coherently beside a `necessary` one.
- **One provenance note becomes stale, and #1963 must rewrite it.** The
  `pharmacy-affords-obtain-medication` assertion's note currently justifies its `necessary` modality
  with "the same claim `affords` makes by declaring `hard` semantics". Once the relation is defeasible,
  that sentence is wrong. Justify it with the concept instead: dispensing medication to the public is
  what makes premises a pharmacy. No test reads that prose, so it must be changed deliberately.
- **Nothing executable depends on the field.** `semantics` is validated as a closed-vocabulary member
  (`ValidationIssueCode.UnknownRelationSemantics`), and nothing else in the package reads it.
  `compile.ts` computes the closure over `isA` alone, and its comments state that `transitive` and
  `inverse` are vocabulary it does not materialize. The correction changes what the record means to a
  reader and to a reviewer, and it changes no compiled byte beyond the field itself.

#### What the closed vocabularies do not need

- **`ConceptKind` gains no member, and this review does not modify
  `packages/geographic-model/lib/schema.ts`.** `drugstore` is a class of premises a person can go to,
  which is `establishment`, and `affords` already accepts that kind on the asserting side. Wave 1
  authors no `place`-kind concept and no `activity`-kind concept beyond the two §4 froze.
- **`ExternalVocabulary` gains no member.** W1-3 points into `poi-taxonomy`, its only member. A second
  vocabulary would turn `ExternalMappingRecord` into a union discriminated on `vocabulary`, which is a
  real schema revision, and nothing in wave 1 needs one.
- **`Modality` and `RelationSemantics` gain no member.** `strongly_expected` and `defeasible` are both
  already in those vocabularies.

#### Considered and excluded

| Candidate                                                            | Excluded because                                                                                                                                                                                                                                                                                                                         |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A second activity, any                                               | No committed input set holds an activity-phrased query for any activity but `obtain_medication`; the four rows that exist (`sem-act-us-01`, `sem-act-us-02`, `sem-act-fr-01`, `sem-act-mx-01`) all register that one. §5.5's first bound therefore still stands for every other activity: there is nothing committed to measure against. |
| Concept `hospital`, from board row `syn-01` (`er near Denver CO`)    | The row **passes** today. A passing row is a control rather than a target — stop condition 4 wants a mechanism the observation can address, and nothing measures a missing `obtain_medication` affordance for a hospital.                                                                                                                |
| Concept `chemist` for en-GB / en-AU / en-NZ                          | Not a class. `curated-overlay.json` carries `{ "phrase": "chemist", "categoryID": "pharmacy", "locales": ["en-GB", "en-AU", "en-NZ"] }`, and §5.2 measured `chemist near London` under `en-GB` reaching `cat=pharmacy` at confidence 1. The existing `pharmacy` concept and W1-3's sibling mapping already carry it.                     |
| `chemist` with no locale supplied — §5.2 measured `NO SUBJECT MATCH` | A real measured gap and not a semantic one. The phrase index is locale-scoped and the miss is in recognition; the phrase surface belongs to `@mailwoman/poi-taxonomy` and to #1962. Minting a concept would not change that result.                                                                                                      |
| Concepts `supermarket` / `convenience_store` as further afforders    | Plausible and unattested. Both ids exist in the table; neither has a committed row, a measurement, or a filed defect saying a dispensing counter is unreachable. Plausibility is the thing stop condition 4 exists to refuse.                                                                                                            |
| W1-2's claim extended to `CA`, `GB` or `MX`                          | §5.3's counts there (CA 369, GB 117, MX 3) bound a population and assert nothing about what those premises afford — the record says so in place. No committed curator statement scopes the class to those countries the way the en-US entry does.                                                                                        |
| W1-2's claim extended to `FR`                                        | Additionally refuted by the data: §5.3's FR `drugstore` count is a **measured zero**, from a group-by that scanned every row. There is nothing for the mapping to reach.                                                                                                                                                                 |
| Board row `cat-ca-02` (`gas station near Ottawa ON`) as a target     | A pre-existing board failure with no affordance content. `docs/records/evals/2026-08-03-backend-parity.md` traces it: the candidate backend anchors on Ottawa, **Illinois**, 1,151 km out, while `Ottawa, ON` with the comma passes. An anchor-resolution defect on the POI path, owned by the runtime and resolver per §3.              |
| Board row `brand-us-02` (`applebee's near Dallas TX`) as a target    | The other pre-existing failure, also without affordance content. `docs/records/evals/2026-07-20-poi-query-board-v1.1-brand-lexicon.md` traces it: subject match and anchor both succeed, and the miss is `#searchKRing`'s `DEFAULT_MAX_RINGS = 12` (≈ 4 km) against a nearest matching row at 13.2 km. A reader search radius.           |
| Probe row `sem-act-fr-01` as a target for new semantics              | Its blocker is not semantic. #1930's caveat 1 and #1039 both record it: a `poi.db` entry named `Somewhere` claims the prefix before the `near` split is considered, so `matchPOISubject` never reaches the activity phrase. No concept, assertion or mapping changes that.                                                               |
| A second relation — `isa` as a relation record, `partOf`, `sells`    | §4 keeps relations unminted until an executable need names one. Wave 1's need is one further asserting concept under the relation that already exists.                                                                                                                                                                                   |
| A second external vocabulary — Wikidata QIDs, OSM tags               | The board's `brandWikidata` values identify **brands** rather than concept classes, and the one brand row that fails does so on search radius. No attested target, and the member addition is a schema revision.                                                                                                                         |
| Concept `retail_establishment` as an intermediate above `drugstore`  | Symmetry with `healthcare_facility` is not a target. That intermediate exists because §4's frozen increment named one; nothing names this one, and an intermediate carrying no assertion adds a review obligation and states nothing.                                                                                                    |

#### What this amendment does not change

- **Ranking behavior**, exactly as §4 froze it. No wave-1 record emits an ordering, a score term, a boost
  or a penalty, and the schema has no numeric field that could carry one.
- **Retrieval.** #1933 owns the related retrieval defect: the en-US `drugstore` synonym can never be
  reached, because the category's own id-as-phrase is inserted into the index first and both score
  `1.0`. That retrieval defect stays outside this program. Wave 1 admits the **semantic half only**:
  that the class exists, what it affords, where, and on whose authority.
- **The coverage rule.** §4's rule applies to every wave-1 record unchanged. Absence becomes negative
  evidence only where `supportsExclusion(...)` permits, which §2.3 measured as nowhere in today's
  `poi.db`.
- **The default path.** #1930's caveat 3 verified that the semantic route is off by default everywhere.
  Wave 1 changes what the compiled artifact carries rather than what the shipped pipeline reads.

#### Re-measure before authoring

§8's instruction applies to this amendment's numbers too, and not all of them were re-measured. The
§5.3 row counts quoted above are that section's measurement at `poi.db` manifest `2026-07-22.0`.
**No `poi.db` was reachable from the checkout this amendment was written in**, so they are carried
forward rather than re-verified. Two of them affect decisions, so #1963 re-runs §8's
`group by category_id, country` pass and compares the manifest version before freezing any wave-1
provenance. An FR count above zero would reopen the FR exclusion, and a changed US count would change
what W1-2's target attests. The taxonomy read-back in W1-3 and both `curated-overlay.json` quotations
**were** verified on HEAD and are current at table `0.4.0` / Overture `v1.17.0`.

#### Authored 2026-08-27 (#1963) and completed 2026-08-28 (#1980): all three records landed

**The census was re-run and every figure above stands.** One `group by category_id, country` pass over the
shipped `poi.db` — manifest `2026-07-22.0`, `build_sha` `3610771ec`, sealed `2026-08-19` — reproduces §5.3
cell for cell: `pharmacy` 82,168 (US 44,945 · GB 7,694 · FR 11,984 · CA 9,617 · MX 7,928) and `drugstore`
7,168 (US 6,679 · GB 117 · **FR 0** · CA 369 · MX 3), over 14,664,001 rows in five countries. **The FR
exclusion stays closed.** Both the full group-by scan and a direct count confirm the zero, and
**W1-2's US target is unchanged** at 6,679 of 7,168. One correction applies to how the figure is taken.
Joining `poi.category_id` through `poi_category_codes` drops 773,210 rows carrying the sentinel
`category_id = 0` without reporting them, so the layer total must be read unjoined. Neither
pharmacy-adjacent leaf is affected.

**What landed:** W1-1 (the `drugstore` concept), W1-2 (its US-scoped `strongly_expected` assertion),
and the vocabulary correction. `affords` now reads `semantics: "defeasible"`, and the pharmacy
assertion's provenance note is now justified by the concept as this section requires. The compiled
model moves to `0.2.0`.

**W1-3, the `poi-taxonomy` mapping, landed on 2026-08-28 behind #1980, and this note closes it out.**
It was held for one release cycle because of an interim rule that the companion decision record's §8.1
authorizes: a declared phrase whose activity reaches more than one mapped kind is refused at
construction. That rule merged ahead of the semantics in PR #1979. With W1-3 authored, all eleven
declared phrases would have been refused, the semantic route could not have been built, and the
capability #1930 recorded GO on would have been lost. `reachKinds` counts only mapped kinds, so an
asserted but unmapped `drugstore` recorded the full semantics while leaving the route intact. That is
why only the mapping was held. #1980 replaced the interim refusal with §8.1's decided shape: **the POI
branch searches the union of the categories the subject reaches, and the resolver's existing candidate
ordering ranks the results.** A plural affordance is now answered rather than refused. The compiled
model moves to `0.3.0`. The deferral did not widen wave 1: nothing outside the admitted table was
authored, and nothing admitted was withdrawn.

**Attested target for the set:** board row `sem-act-us-03` (`where can i pick up a prescription near
Coalinga CA`). The board grades outcomes and never recall, so this row is the case where the two
readings agree. Measured through the board's own pipeline, `pharmacy near Coalinga CA` resolves the
anchor and returns zero rows, while `drugstore near Coalinga CA` returns two at 0.77 km and 1.71 km.
With the union searching both classes, the row answers `drugstore` at 0.77 km, which W1-3 makes
reachable. The row states no preference between the classes, because at that anchor only one class has
results. The row stays TRACKED and is re-pointed from #1980 to #1967. Its subject reaches no committed
lexicon entry, so without the opt-in route injected the query takes no POI branch at all. Whether the
route reaches the default path is #1967's question rather than this record's. The POI board's floors
are registered against the construction with the route off, and they have not changed.

---

## 5. The failure class for the utility probe (#1928)

The probe must not feed `pharmacy affords obtain_medication` back into a query the system already
recognizes as `pharmacy`. That observation is redundant there, and a null result would prove nothing.
The class below was chosen because the affordance edge supplies information that the baseline path
lacks entirely.

### 5.1 The class

**Activity-named POI query.** The query describes _what the user wants to do_. The system has no route
from an activity to the set of entity kinds that afford it, and no single category is the right answer
even after the phrase is understood.

The attested controls are committed in `packages/mailwoman/lib/eval-harness/fixtures/poi-board.jsonl`.
They use the venue-noun form of the same intent and pass today:

| Row         | Query                     | Expectation                                      |
| ----------- | ------------------------- | ------------------------------------------------ |
| `cat-us-05` | `pharmacy near Denver CO` | `categoryID: pharmacy`, anchor Denver, ≤ 25 km   |
| `cat-mx-02` | `pharmacy near Tijuana`   | `categoryID: pharmacy`, anchor Tijuana, ≤ 25 km  |
| `cat-fr-03` | `pharmacy near Toulouse`  | `categoryID: pharmacy`, anchor Toulouse, ≤ 25 km |

The target form is **synthetic and labeled as such**. It uses the same anchors with the venue noun
replaced by an activity phrase, so anchor resolution is held constant and only the subject varies.

- `where can i pick up a prescription near Denver CO`
- `somewhere to fill a prescription near Toulouse`
- `i need my prescription refilled near Tijuana`
- `prescription near Denver CO`

### 5.2 What the baseline does — measured rather than reasoned

Running the shipped `matchPOISubject` against the shipped `poiTaxonomyLookup`:

```text
"pharmacy near Denver CO"                            en-US  subject="pharmacy"  cat=pharmacy   conf=1
"drugstore near Denver CO"                           en-US  subject="drugstore" cat=drugstore  conf=1
"chemist near London"                                en-GB  subject="chemist"   cat=pharmacy   conf=1
"chemist near London"                                —      NO SUBJECT MATCH
"where can i pick up a prescription near Denver CO"  en-US  NO SUBJECT MATCH
"somewhere to fill a prescription near Toulouse"     fr-FR  NO SUBJECT MATCH
"i need my prescription refilled near Tijuana"       en-US  NO SUBJECT MATCH
"prescription near Denver CO"                        en-US  NO SUBJECT MATCH
"24 hour prescription pickup near Chicago IL"        en-US  NO SUBJECT MATCH
```

Every activity phrase misses. All 55 committed synonyms are venue nouns, and the taxonomy matches exact
phrases. The fallbacks cannot close the gap. Locale-normalized matching folds diacritics over the same
phrase index, and the one-edit typo path requires a length difference ≤ 1 against an existing phrase.
`createScorePOIQuery` therefore returns `0`, and the input leaves the POI branch entirely. The system
answers an activity query by parsing the sentence as an address.

### 5.3 Why the class is _deliberately underdetermined_

The obvious repair is to add `prescription → pharmacy` to the synonym table. That repair is wrong at the
type level, and the layer's own contents show why.

`SynonymEntry.categoryID` is a **single** id. An activity is afforded by a **set** of kinds, and the
set depends on the country. The shipped `poi.db` holds 14,664,001 rows over exactly five countries
(US 10,688,365 · GB 1,632,103 · FR 818,165 · CA 786,925 · MX 738,443):

| Overture leaf | Hierarchy branch                | Rows   | US     | GB    | FR     | CA    | MX    |
| ------------- | ------------------------------- | ------ | ------ | ----- | ------ | ----- | ----- |
| `pharmacy`    | `health_and_medical > pharmacy` | 82,168 | 44,945 | 7,694 | 11,984 | 9,617 | 7,928 |
| `drugstore`   | `retail > drugstore`            | 7,168  | 6,679  | 117   | 0      | 369   | 3     |

The `0` is a measured zero. The group-by scanned every row, so the layer carries no `drugstore` row in
FR, and the cell was read.

The two leaves sit in **disjoint top-level branches**, so containment cannot join them. `pharmacy`
declares no `overtureCategories`, so the executor probes only `["pharmacy"]`, and `#searchKRing` never
sees a `drugstore` row. **7,168 of the 89,336 rows under the two leaves (8.0%, or 12.9% within the US)
are structurally out of reach of the shipped `pharmacy` query.** Whether a given `drugstore` row
affords `obtain_medication` is the claim the affordance edge would carry, with provenance. The row
counts here bound the population that claim would cover and assert nothing about it. The proportions
vary by country, which shows the country dependence directly.

The same measurement shows a second, clearer example. The curated overlay ships a locale-hinted
synonym `drugstore → pharmacy` (en-US), and it **never reaches a caller**. The phrase index in
`packages/poi-taxonomy/lib/lookup-core.ts` inserts each category's id-as-phrase and label before the
synonym table. `lookupPOICategory` deduplicates by category and sorts by confidence descending, and
both entries score `1.0` under an `en-US` locale. The stable sort therefore leaves the `drugstore`
_category_ at index 0, and `matchPOISubject` consumes only `hits[0]`. `PROVENANCE.md` documents the
mechanism that normally prevents this: the generator suppresses an Overture leaf already absorbed by a
curated record's `overtureCategories`, "so a curated synonym like `coffee shop` → `cafe` is never
shadowed by the `coffee_shop` snapshot leaf". `pharmacy` absorbs no leaves, so nothing is suppressed.

At the query surface, `pharmacy` reaches 44,945 US rows and `drugstore` reaches 6,679. The two sets
are disjoint, and the English word the caller typed decides which one they reach. **This record
proposes no change to that behavior**, because §4 freezes ranking and retrieval. The behavior is
recorded because it shows, on committed data, that the missing information is an affordance edge over
a _set_ rather than a missing phrase.

### 5.4 The missing distinction, stated for pre-registration

> Which entity kinds afford `obtain_medication`, in which country, with what modality, and on whose
> authority.

That is a one-activity-to-several-kinds edge carrying scope and provenance, and nothing on HEAD can
hold it. `SynonymEntry.categoryID` is single-valued and has no relation. `CategoryRecord.hierarchy` is
containment. `CategoryRecord.overtureCategories` is a namespace translation authored per seed, without
a relation type, country scope, or per-assertion provenance.

### 5.5 Bounds #1928 must respect

- **No committed input set contains an activity-shaped query.** Nothing under
  `packages/mailwoman/lib/eval-harness/fixtures/` matches an activity phrasing. The program's own
  precondition requires target rows mined from committed corpora that predate the probe, so §5.1
  cannot meet it with the current corpora. #1928 must either commit the rows to the POI board first
  (graded on outcomes only, per the anti-Pelias commitment in
  `docs/superpowers/specs/2026-08-17-mechanism-accounts.md` §2), or pre-register on the §5.3 recall
  gap, whose control rows are already committed. Manufacturing a passing fixture triggers a stop
  condition and is not an acceptable workaround.
- **The board's grader cannot see the §5.3 gap.** `gradeCase` checks `results[0].categoryID` and the
  nearest distance, and it never measures recall. `cat-us-05` passes today and would still pass with
  every `drugstore` row missing. A probe on §5.3 needs its own recall metric.
- **The baseline failure shape is not a `DIAGNOSE_SHAPES` value.** See §2.6.
- **A hand-authored board over-represents the defect it was written for.** Whatever rows #1928 freezes,
  the delta they measure describes those rows. The control set keeps that delta from being read as a
  statement about production traffic.

---

## 6. Exclusions and stop conditions

**Architectural exclusions.** These are properties of the program rather than of a phase:

- No OWL/DL reasoner, SPARQL endpoint, triplestore, or general-purpose knowledge-graph service.
- No query-time traversal of authoring JSON, and no runtime dependency on thousands of authoring
  records. Authored records are source material compiled into deterministic runtime artifacts rather
  than services.
- No authored relevance weights, boosts, penalties, or candidate-ordering APIs anywhere in the
  geographic model.
- No `@mailwoman/core` dependency on `@mailwoman/geographic-model` without a later integration
  decision. **That decision was taken on 2026-08-27 (#1966) and declined the permission.** See
  [the integration decision](./2026-08-27-semantic-route-integration-decision.md) §3.2 and §10. The
  dependency direction is `mailwoman` → `@mailwoman/geographic-model`. This exclusion stays unamended,
  and a future proposal to weaken it must amend both records.
- Source observations stay separate from derived facts, and every mapping and derivation preserves
  provenance.
- Missing data becomes negative evidence only through exclusion-grade coverage supplied by
  `@mailwoman/core/layers`.
- Law tests extend the existing gauntlet, board, trace, and dev-MCP implementation instead of a
  separate test system.
- The program must not create a second POI taxonomy, a second `layer_manifest`/`layer_coverage`, a
  second POI intent pipeline, or a second affordance vocabulary independent of #1683.

**Deferred by name:** roads, utilities and electrification, population context, environmental
statistics, water/land compatibility, coverage inference, spatial statistics, mapping breadth beyond
§4.1's wave-1 set, and production decoder integration.

**Stop conditions.**

1. **The check binds later phases.** After the minimal `pharmacy → obtain_medication` proposition
   exists, #1928 records exactly one of **GO**, **DIAGNOSTIC-ONLY**, or **STOP/REDESIGN**, against a
   ruler frozen before any probe code is written. Nothing beyond the design proposal's C4 begins
   before GO, except separately justified evidence and provenance work after a DIAGNOSTIC-ONLY result.
2. **A failed probe does not convert into a diagnostics mandate.** A large downstream phase still needs
   a concrete product requirement — diagnosis, explainability, inferential resolution, or a measured
   failure class — on its own evidence.
3. **DIAGNOSTIC-ONLY requires a pre-registered structured metric.** A free-form claim of better
   diagnosis or better abstention does not satisfy the check.
4. **A probe requires a real target.** If no defensible target exposes a mechanism the first
   affordance observation can address, record that the first increment lacks one, then choose a
   different observation or stop. Do not author a fixture whose only purpose is to pass.
5. **This record's boundary is amended explicitly.** A change that needs a second relation, a second
   activity, a second entity kind, or a `@mailwoman/core` dependency amends §3 or §4 in a reviewed
   change. It does not widen them in passing.
6. **Refresh before filing.** The repository changes. An implementer who finds that a §2 path moved or
   a listed boundary already landed updates the inventory before opening work against it.

---

## 7. What this record does not settle

- The authored-record format, the compiled-artifact format, and the validation rules for
  `@mailwoman/geographic-model`. This record freezes ownership and leaves the shape open.
- Where the runtime join between candidates, layer evidence, and world facts lives. §3 assigns it to
  the runtime and resolver, and the integration point is a later decision.
- Whether the `poi.db` coverage register gets an earned basis, and by what measurement. §2.3 records
  only that it has none today, which is what makes the increment's coverage rule a check rather than a
  capability.
- The `drugstore`/`pharmacy` retrieval split in §5.3. It is recorded as evidence. Ranking and retrieval
  behavior are unchanged by this record, and any repair is separate work with its own D-rule
  obligations. That repair is now filed as **#1933** and stays outside this program. §4.1 admits only
  the semantic half of the same problem.

---

## 8. How the numbers here were taken

This section lets a reader re-run the measurements rather than trust them.

- **Vocabulary counts** (§2.1, §4): read directly from
  `packages/poi-taxonomy/data/curated-overlay.json` and
  `packages/poi-taxonomy/data/taxonomy.json`. The six categories declaring `overtureCategories` are
  `bank`, `cafe`, `place_of_worship`, `school`, `supermarket`, `trail`.
- **Subject-match table** (§5.2): each query passed to `matchPOISubject` from
  `@mailwoman/kind-classifier` with the shipped `poiTaxonomyLookup` from
  `packages/mailwoman/lib/poi-intent.ts` and the locale shown. The run used no model, database, or
  network, because the lexicon probe is the whole mechanism under test.
- **Layer counts and coverage** (§2.3, §5.3): one read-only `node:sqlite` pass over the shipped
  `poi.db` at `dataRootPath("poi", "poi.db")`, joining `poi.category_id` through
  `poi_category_codes`, plus `select basis, count(*), min(completeness), max(completeness) from
layer_coverage group by basis` and the single-row `layer_manifest`. One `group by category_id,
country` scan produces every category figure at once. The artifact is sealed and read-only, so the
  measurement cannot modify it.

Re-measure before reusing any figure here. `poi.db` is a rebuilt, sealed artifact, and its manifest
version (`2026-07-22.0` at the time of writing) identifies which build a figure describes.
