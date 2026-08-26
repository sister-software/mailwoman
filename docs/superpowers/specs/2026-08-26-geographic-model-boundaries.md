# Geographic-model boundaries and the pharmacy first slice

**Date:** 2026-08-26 · **Status:** design of record; no code lands with it · **Issue:** #1917 ·
**Epic:** #1916 (program parent #1680) · **Companions:** #1683 (empirical activity-affordance
vector), #1928 (the semantic-utility probe this record supplies a target for).

This record does two things and nothing else. It **names the current owner** of every seam the
world-model program would otherwise re-create, each against a path that exists on HEAD; and it
**freezes one vertical slice** — `pharmacy affords obtain_medication` — so that every later issue in
the program has a fixed target to be judged against.

No package is created here. `@mailwoman/geographic-model` appears throughout as a **recorded
ownership boundary**, not as a workspace: it does not exist in the root `workspaces` array, in
`.release-it.json`, or under `packages/`, and this record does not add it. The first issue that
scaffolds it inherits the responsibilities named in §3 and nothing beyond them.

---

## 1. Why an inventory comes first

The repository already holds a POI category vocabulary, a phrase→category lexicon, a POI intent and
execution path, a per-cell coverage contract with an exclusion predicate, a committed POI board, and
a mechanism-account vocabulary. Every one of those is a seam a semantic layer is tempted to
duplicate, and two of them (`@mailwoman/poi-taxonomy`, `@mailwoman/core/layers`) are close enough to
"world knowledge" that an implementer could reasonably grow one into a general ontology without
noticing they had made that decision.

The failure this record is aimed at is therefore not "we lack a design". It is **a second copy of an
existing seam, or world semantics landing inside `@mailwoman/core`.** The inventory below is what
makes that visible at review time: if a change proposes a concept, a mapping, or a coverage rule, §2
says who already owns the nearest thing, and §3 says whether the new work belongs there.

---

## 2. Seam inventory against HEAD

Every path in this section was read at the commit this record was written against.

### 2.1 POI categories — `@mailwoman/poi-taxonomy`

| What                                | Where                                                                                                                                    |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Category record + branded id        | `packages/poi-taxonomy/types.ts` (`CategoryRecord`, `POICategoryID`, `CategorySource`)                                                   |
| Authored curated layer              | `packages/poi-taxonomy/data/curated-overlay.json` — 26 category records, 55 synonym phrases                                              |
| External snapshot                   | `packages/poi-taxonomy/data/overture-categories.csv` — Overture schema `v1.17.0`, CDLA-Permissive-2.0                                    |
| Generated, committed merge          | `packages/poi-taxonomy/data/taxonomy.json` — 2,113 categories, 55 synonyms; **do not hand-edit**                                         |
| Provenance + regeneration procedure | `packages/poi-taxonomy/data/PROVENANCE.md`                                                                                               |
| Matching core                       | `packages/poi-taxonomy/lookup-core.ts` (`createLookupCore`, `lookupPOICategory`, `requiresBuildLocalLayer`, `resolveOvertureCategories`) |

Three structures exist over categories, and none of them is a relation in the sense this program
needs:

1. **`CategoryRecord.hierarchy`** — ordered ancestry, top level first, ending with the category's own
   id. It is **containment within one vocabulary**, authored by Overture. `pharmacy` reads
   `health_and_medical > pharmacy`; `drugstore` reads `retail > drugstore`.
2. **`CategoryRecord.overtureCategories`** — a **namespace translation**, curated seed id → the
   Overture `taxonomy.primary` leaf ids a built `poi.db` actually stores. Six of 2,113 categories
   declare one (`bank`, `cafe`, `place_of_worship`, `school`, `supermarket`, `trail`). Absent means
   identity: the seed id is its own probe id.
3. **`SynonymEntry`** — one phrase, **one** `categoryID`, optionally locale-gated
   (`packages/poi-taxonomy/types.ts`). The cardinality is the point: the field is a single id, so a
   phrase can never name a set.

There is no relation type, no modality, no country scope, and no per-assertion provenance anywhere in
this package. Its provenance is per-FILE (`PROVENANCE.md`), which is the right grain for a vocabulary
snapshot and the wrong grain for a derived fact.

### 2.2 World semantics — unowned on HEAD

Nothing in the repository expresses `A affords X`, or any other non-taxonomic relation between a place
kind and something a person does there. The nearest structures are the three in §2.1, and each fails
for a stated reason: containment is not affordance, namespace translation is not affordance, and a
single-valued synonym cannot hold a set. This is the gap the program opens, and §3 assigns it.

### 2.3 Coverage epistemics — `@mailwoman/core/layers`

| What                                | Where                                                                                                          |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Contract tables + DDL               | `packages/core/layers/schema.ts` (`LayerManifestTable`, `LayerCoverageTable`, `LayerTier`, `CoverageBasis`)    |
| Parsed face + read/write + the gate | `packages/core/layers/manifest.ts` (`LayerManifest`, `CoverageCell`, `supportsExclusion`, `readLayerCoverage`) |
| Barrel                              | `packages/core/layers/index.ts`                                                                                |
| Contract prose for layer authors    | `docs/engineering/reference/layer-contract.mdx`                                                                |
| Cell-vs-scope coverage design       | `docs/superpowers/specs/2026-08-11-coverage-register-design.md`                                                |

`supportsExclusion(cell)` returns true only for `CoverageBasis.Designated` or
`CoverageBasis.Surveyed`. `CoverageBasis.SourcePresent` supports presence and nothing else — the
source looked, which is not the same as the source found everything. A missing `layer_coverage` row
means unmapped, never surveyed-and-empty.

**Measured against the shipped layer** (`poi.db`, manifest `name: poi`, `version: 2026-07-22.0`,
`tier: shipped`, `source: overture-places`, `source_vintage: 2026-07-22.0`): 158,813 coverage cells,
**every one at `basis = source_present`**, `completeness` min and max both `1.0`. The writer says so
in place — `packages/mailwoman/gazetteer-pipeline/poi/build-poi.ts` sets
`basis: CoverageBasis.SourcePresent` on both the rows-derived and the override coverage sets, with a
comment stating that the `1.0` means "Overture returned rows here", not "everything here is known".

The consequence binds the slice in §4: **`supportsExclusion` is false for every cell of the shipped
POI layer today.** Any coverage-aware negative fact the program authors is therefore inert against
`poi.db` until that register is rebuilt with an earned basis. That is the correct behavior, not a
defect to route around, and it is why the slice states the coverage rule as a gate rather than as a
capability.

### 2.4 Execution — the runtime POI branch

| Stage                         | Where                                                                                                                |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Subject/anchor split          | `packages/kind-classifier/poi.ts` (`matchPOISubject`, `createScorePOIQuery`, `createScorePOICategory`)               |
| Lexicon adapter + stage build | `packages/mailwoman/poi-intent.ts` (`poiTaxonomyLookup`, `createPOIIntentStage`)                                     |
| Intent execution              | `packages/mailwoman/poi-executor.ts` (`createPOIExecutor`)                                                           |
| Backend probe                 | `packages/resolver-wof-sqlite/poi-lookup.ts` (`POILookup.search`, `#searchKRing`)                                    |
| Wiring                        | `packages/mailwoman/runtime-pipeline.ts` (`poiQueryKind`, default-on)                                                |
| Contract types                | `packages/core/pipeline/types.ts` (`POIIntent`, `POIResult`, `POIIntentOutcome`)                                     |
| Layer build                   | `packages/mailwoman/gazetteer-pipeline/poi/build-poi.ts`                                                             |
| Committed board + fixtures    | `packages/mailwoman/eval-harness/poi-board.ts`, `packages/mailwoman/eval-harness/fixtures/poi-board.jsonl` (51 rows) |

The path is: `matchPOISubject` splits the input at the first anchor separator whose prefix hits the
injected lexicon (subject ≤ 8 tokens) → `poiTaxonomyLookup` probes exact phrase, then a small English
singularization, then locale-normalized, then one-edit typo, then brand, then regional brand alias →
the executor resolves an anchor centre and probes `poi.db` over
`resolveOvertureCategories(subject.categoryID)`, re-tagging every hit back to the canonical seed id.

Two properties of that path matter to §5. The lexicon probe is **positive evidence only**: a miss
returns `[]`, `matchPOISubject` returns `null`, `createScorePOIQuery` returns `0`, and the input never
takes the POI branch at all. And the backend probe is **exact set membership** over Overture leaf ids:
`#searchKRing` resolves each seed id through `poi_category_codes` and silently drops ids the layer does
not carry.

The abstain vocabulary is small and already structured: `POIIntentOutcome` is
`{ type: "intent"; intent; results? }` or `{ type: "abstain"; reason }`, with
`requires_build_local_layer` and `anchor_required` as the two reasons the executor emits.

### 2.5 Learned decoding and ranking — `@mailwoman/neural`, `@mailwoman/core/decoder`, `@mailwoman/resolver`

| What                           | Where                                                                                                                                        |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Decode-time grammar + tree     | `packages/core/decoder/` (`build-tree.ts`, `validate-tree.ts`, `types.ts`)                                                                   |
| Grammar contract               | `docs/engineering/reference/decoder-grammar.mdx`                                                                                             |
| Inference + decode-time priors | `packages/neural/` (`scorer.ts`, `viterbi.ts`, `semi-markov-decode.ts`, `placetype-pair-prior.ts`, `fst-prior.ts`, `gazetteer-inference.ts`) |
| Candidate ordering             | `packages/resolver/toponym-prior.ts` (`rankByImportance`), `packages/resolver/admin-containment.ts`                                          |

This is the seam the program must not reach into. The standing doctrine is that registries are soft
priors supplying **positive evidence only**, and the decoder grammar contract states which terms the
shipped decoder maximizes. A world-model record that emitted a boost, a penalty, or a candidate order
would be authoring policy at the one place where the system is supposed to learn its own.

### 2.6 Measurement surfaces that already exist

| Surface                                                           | Where                                                                  |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------- |
| POI query board (assembled-answer grading, pre-registered floors) | `packages/mailwoman/eval-harness/poi-board.ts`                         |
| Gauntlet cases                                                    | `packages/mailwoman/eval-harness/gauntlet/`                            |
| Warm-engine measuring tools                                       | `packages/dev-mcp/tools/`                                              |
| Mechanism-account shapes                                          | `packages/dev-mcp/diagnose.ts` (`DIAGNOSE_SHAPES`, `SHAPE_PREDICATES`) |
| Diagnosis conventions                                             | `docs/superpowers/specs/2026-08-17-mechanism-accounts.md`              |

One bound worth stating now, because #1928 will hit it: `DIAGNOSE_SHAPES` is a vocabulary of
**address-path** mechanism states — parse, evidence, retrieval, ranking, outcome. It contains no state
describing the POI branch (no subject-match state, no abstain-reason state). The POI branch's own
structured vocabulary is `POIIntentOutcome` plus the board's `POIBoardExpect["kind"]`. A probe that
pre-registers a `baselineFailureShape` for a POI query must name one of those, or extend the
mechanism-account vocabulary deliberately — it cannot borrow an address-path shape and mean anything
by it.

---

## 3. The package boundary

| Owner                                                                                              | Owns                                                                                                                                                                                                                                                                     | Must not own                                                                                                         |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `@mailwoman/poi-taxonomy`                                                                          | External and curated POI category vocabulary; category hierarchy; the Overture-leaf translation; query phrase → category lexicon; brands                                                                                                                                 | Relations other than containment; activities; affordances; per-assertion provenance                                  |
| `@mailwoman/geographic-model` **(future; recorded ownership only — the workspace does not exist)** | Stable concepts beyond the POI vocabulary; relation definitions; activities and affordances; rule modality; source observations; derived facts; derivation provenance; deterministic compilation and validation; mappings from external vocabularies into world concepts | Ranking weights, boosts, penalties, or any candidate-ordering API; a second POI taxonomy; a second coverage register |
| `@mailwoman/core/layers`                                                                           | Dataset identity (`layer_manifest`); coverage epistemics (`layer_coverage`, `CoverageBasis`, `supportsExclusion`)                                                                                                                                                        | World semantics of any kind                                                                                          |
| Mailwoman runtime / resolver                                                                       | Candidate lookup, anchor resolution, POI execution, and the join of candidates with layer evidence and (later) world facts; candidate ordering                                                                                                                           | Authored world knowledge                                                                                             |
| Learned decoding (`@mailwoman/neural`, `@mailwoman/core/decoder`)                                  | Interpretation of observations; the decode objective                                                                                                                                                                                                                     | Authored imperatives that bypass interpretation                                                                      |
| #1683                                                                                              | Empirical, spatial activity-affordance statistics fitted from data                                                                                                                                                                                                       | The stable activity/affordance identifiers themselves — those come from the geographic model                         |

Two dependency rules follow, and both are load-bearing:

- **`@mailwoman/core` must not depend on `@mailwoman/geographic-model`** without a later integration
  decision that demonstrates the direction is necessary. Core ships the pipeline contract and ~9 MB of
  reference data to every consumer; a world-semantics dependency there is a dependency every drop-in
  API inherits whether or not it asked for one.
- **The geographic model and #1683 share identifiers, not statistics.** The geographic model owns
  `obtain_medication` as a stable identifier with provenance; #1683 owns whatever numbers get fitted
  against it. Neither re-declares the other's half. That split is what keeps an authored relationship
  from turning into a weight by adjacency.

The operating rule for the whole boundary is one sentence: **knowledge creates observations; it never
overrides learned interpretation.** A world-model record may create a fact, an anomaly, a
contradiction, or a coverage-qualified absence. It may not create an imperative.

---

## 4. The frozen vertical slice

Verbatim from #1917. Every Phase B–F issue in the program is judged against this block, and any change
to it is an explicit amendment to this record, not a widening in passing.

```text
entity kind: pharmacy
activity: obtain_medication
external vocabulary: @mailwoman/poi-taxonomy pharmacy
world relation: affords
semantic proposition: pharmacy affords obtain_medication
coverage rule: absence is negative evidence only when supportsExclusion(...) permits it
ranking behavior: unchanged
```

What each line binds:

- **entity kind: `pharmacy`** — the only establishment class the first slice requires. No sibling
  class is minted to make the proposition read better.
- **activity: `obtain_medication`** — the only activity. It is an identifier the geographic model
  owns; #1683 may later fit statistics against it, and this record does not.
- **external vocabulary** — the mapping target is the category with id **`pharmacy`** (a
  `POICategoryID`), record `{ id: "pharmacy", label: "Pharmacy", hierarchy: ["health_and_medical",
"pharmacy"], basicLabel: "Pharmacy", osmTag: "amenity=pharmacy", source: "overture" }`, authored in
  `packages/poi-taxonomy/data/curated-overlay.json` and emitted into
  `packages/poi-taxonomy/data/taxonomy.json`. The category declares no `overtureCategories`, so
  `resolveOvertureCategories("pharmacy")` is the identity `["pharmacy"]`.
- **world relation: `affords`** — the only non-taxonomic relation. `isa`, `partOf`, and any other
  relation stay unminted until an executable need names one.
- **coverage rule** — a missing expected observation becomes negative evidence only where
  `supportsExclusion(...)` from `packages/core/layers/manifest.ts` permits it. As measured in §2.3,
  that permits nothing against today's `poi.db`; the rule is written as a gate so the first slice
  cannot accidentally ship an exclusion the data does not support.
- **ranking behavior: unchanged** — no ordering, score term, boost, or penalty changes anywhere in
  `packages/resolver/` or `packages/neural/` as a consequence of this slice. First production
  integration is diagnostic and observational only.

Deferred by name, even where convenient during implementation: roads, utilities and electrification,
population context, environmental statistics, water/land compatibility, mapping breadth beyond the one
category above, and any production decoder integration.

---

## 5. The failure class for the utility probe (#1928)

The probe must not feed `pharmacy affords obtain_medication` back into a query the system already
recognizes as `pharmacy`. That observation is redundant there, and a null result would prove nothing.
The class below is chosen because the affordance edge supplies information the baseline path does not
contain at all.

### 5.1 The class

**Activity-named POI query.** The query names _what the user wants to do_; the system has no route
from an activity to the set of entity kinds that afford it, and no single category is the right answer
even after the phrase is understood.

Attested controls (committed, `packages/mailwoman/eval-harness/fixtures/poi-board.jsonl`) — the
venue-noun form of the same intent, which passes today:

| Row         | Query                     | Expectation                                      |
| ----------- | ------------------------- | ------------------------------------------------ |
| `cat-us-05` | `pharmacy near Denver CO` | `categoryID: pharmacy`, anchor Denver, ≤ 25 km   |
| `cat-mx-02` | `pharmacy near Tijuana`   | `categoryID: pharmacy`, anchor Tijuana, ≤ 25 km  |
| `cat-fr-03` | `pharmacy near Toulouse`  | `categoryID: pharmacy`, anchor Toulouse, ≤ 25 km |

Target form — **synthetic, and labeled as such**: the same anchors with the venue noun replaced by an
activity phrase, so anchor resolution is held constant and the subject is the only thing that varies.

- `where can i pick up a prescription near Denver CO`
- `somewhere to fill a prescription near Toulouse`
- `i need my prescription refilled near Tijuana`
- `prescription near Denver CO`

### 5.2 What the baseline actually does — measured, not reasoned

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

Every activity phrase misses. All 55 committed synonyms are venue nouns, the taxonomy is exact-phrase,
and the fallbacks cannot bridge the gap by construction: locale-normalized matching folds diacritics
over the same phrase index, and the one-edit typo path requires a length difference ≤ 1 against an
existing phrase. So `createScorePOIQuery` returns `0` and the input leaves the POI branch entirely —
an activity query is answered as an address parse of a sentence.

### 5.3 Why the class is _deliberately underdetermined_

The obvious repair — add `prescription → pharmacy` to the synonym table — is wrong at the type level,
and the layer's own contents say why.

`SynonymEntry.categoryID` is a **single** id. An activity is afforded by a **set** of kinds, and the
set is country-conditional. Measured on the shipped `poi.db` — 14,664,001 rows over exactly five
countries (US 10,688,365 · GB 1,632,103 · FR 818,165 · CA 786,925 · MX 738,443):

| Overture leaf | Hierarchy branch                | Rows   | US     | GB    | FR     | CA    | MX    |
| ------------- | ------------------------------- | ------ | ------ | ----- | ------ | ----- | ----- |
| `pharmacy`    | `health_and_medical > pharmacy` | 82,168 | 44,945 | 7,694 | 11,984 | 9,617 | 7,928 |
| `drugstore`   | `retail > drugstore`            | 7,168  | 6,679  | 117   | 0      | 369   | 3     |

The `0` is a measured zero: the group-by scanned every row, so the layer carries no `drugstore` row in
FR — not an unread cell.

The two leaves sit in **disjoint top-level branches**, so containment cannot join them. `pharmacy`
declares no `overtureCategories`, so the executor probes `["pharmacy"]` only and `#searchKRing` never
sees a `drugstore` row: **7,168 of the 89,336 rows under the two leaves (8.0%; 12.9% within the US)
are structurally out of reach of the shipped `pharmacy` query.** Whether a given `drugstore` row
affords `obtain_medication` is exactly the claim the affordance edge would carry, with provenance —
the row counts here bound the population that claim would range over, and assert nothing about it.
The proportions are not uniform across countries, which is the country-conditionality made concrete.

The same measurement exposes a second, sharper witness. The curated overlay ships a locale-gated
synonym `drugstore → pharmacy` (en-US), and it **never reaches a caller**. The phrase index in
`packages/poi-taxonomy/lookup-core.ts` inserts each category's id-as-phrase and label before the
synonym table, `lookupPOICategory` deduplicates by category and sorts by confidence descending, and
both entries score `1.0` under an `en-US` locale — so the stable sort leaves the `drugstore` _category_
at index 0 and `matchPOISubject` consumes `hits[0]` only. `PROVENANCE.md` documents the mechanism that
normally prevents this: the generator suppresses an Overture leaf already absorbed by a curated
record's `overtureCategories`, "so a curated synonym like `coffee shop` → `cafe` is never shadowed by
the `coffee_shop` snapshot leaf". `pharmacy` absorbs no leaves, so nothing is suppressed.

What that produces at the query surface: in the US, `pharmacy` reaches 44,945 rows and `drugstore`
reaches 6,679, the two sets are disjoint, and which one a caller reaches is decided by which English
word they typed. **This record proposes no change to that behavior** — ranking and retrieval are frozen
by §4. It is recorded because it shows, on committed data, that the missing information is an
affordance edge over a _set_ rather than a missing phrase.

### 5.4 The missing distinction, stated for pre-registration

> Which entity kinds afford `obtain_medication`, in which country, with what modality, and on whose
> authority.

That is a one-activity-to-many-kinds edge carrying scope and provenance. Nothing on HEAD can hold it:
`SynonymEntry.categoryID` is single-valued and relation-free; `CategoryRecord.hierarchy` is
containment; `CategoryRecord.overtureCategories` is a namespace translation authored per seed, with no
relation type, no country scope and no per-assertion provenance.

### 5.5 Bounds #1928 must respect

- **No committed input set contains an activity-shaped query.** Nothing under
  `packages/mailwoman/eval-harness/fixtures/` matches an activity phrasing. The program's own
  precondition — target rows mined from committed corpora that predate the probe — therefore cannot be
  met for §5.1 as the corpora stand. #1928 must either commit the rows to the POI board first (graded
  on OUTCOMES only, per the anti-Pelias commitment in
  `docs/superpowers/specs/2026-08-17-mechanism-accounts.md` §2), or pre-register on the §5.3 recall
  gap, whose control rows are already committed. Manufacturing a passing fixture is a stop condition,
  not a workaround.
- **The board's grader cannot see the §5.3 gap.** `gradeCase` checks `results[0].categoryID` and the
  nearest distance; it never measures recall. `cat-us-05` passes today and would pass unchanged with
  every `drugstore` row missing. A probe on §5.3 needs a recall metric of its own.
- **The baseline failure shape is not a `DIAGNOSE_SHAPES` value** — see §2.6.
- **A hand-authored board over-represents the defect it was written for.** Whatever rows #1928 freezes,
  the delta they measure is a statement about those rows, and the control set is what keeps it from
  being read as a statement about production traffic.

---

## 6. Exclusions and stop conditions

**Architectural exclusions.** These are properties of the program, not of a phase:

- No OWL/DL reasoner, SPARQL endpoint, triplestore, or general-purpose knowledge-graph service.
- No query-time traversal of authoring JSON, and no runtime dependency on thousands of authoring
  records. Authored records are source material compiled into deterministic runtime artifacts —
  artifacts, not services.
- No authored relevance weights, boosts, penalties, or candidate-ordering APIs anywhere in the
  geographic model.
- No `@mailwoman/core` dependency on `@mailwoman/geographic-model` without a later integration
  decision.
- Source observations stay separate from derived facts, and every mapping and derivation preserves
  provenance.
- Missing data becomes negative evidence only through exclusion-grade coverage supplied by
  `@mailwoman/core/layers`.
- Law tests extend the existing gauntlet, board, trace, and dev-MCP machinery. No parallel test
  universe.
- No second POI taxonomy, no second `layer_manifest`/`layer_coverage`, no second POI intent pipeline,
  and no second affordance vocabulary independent of #1683.

**Deferred by name:** roads, utilities and electrification, population context, environmental
statistics, water/land compatibility, coverage inference, spatial statistics, mapping breadth, and
production decoder integration.

**Stop conditions.**

1. **The gate binds later phases.** After the minimal `pharmacy → obtain_medication` proposition
   exists, #1928 records exactly one of **GO**, **DIAGNOSTIC-ONLY**, or **STOP/REDESIGN**, against a
   ruler frozen before any probe code is written. Nothing beyond the design proposal's C4 begins
   before GO, except separately justified evidence and provenance work after a DIAGNOSTIC-ONLY result.
2. **A failed probe does not convert into a diagnostics mandate.** A large downstream phase still needs
   a concrete product requirement — diagnosis, explainability, inferential resolution, or a measured
   failure class — on its own evidence.
3. **DIAGNOSTIC-ONLY requires a pre-registered structured metric.** A free-form claim of better
   diagnosis or better abstention does not satisfy the gate.
4. **No real target, no probe.** If no defensible target exposes a mechanism the first affordance
   observation can address, record that the first slice lacks one and choose a different observation or
   stop — do not author a fixture whose only purpose is to pass.
5. **This record's boundary is amended explicitly.** A change that needs a second relation, a second
   activity, a second entity kind, or a `@mailwoman/core` dependency amends §3 or §4 in a reviewed
   change. It does not widen them in passing.
6. **Refresh before filing.** The repository moves; an implementer who finds a §2 path moved or a
   named seam already landed updates the inventory before opening work against it.

---

## 7. What this record does not settle

- The authored-record format, the compiled-artifact format, and the validation rules for
  `@mailwoman/geographic-model`. Ownership is frozen here; shape is not.
- Where the runtime join between candidates, layer evidence, and world facts lives. §3 assigns it to
  the runtime and resolver; the integration point is a later decision.
- Whether the `poi.db` coverage register gets an earned basis, and by what measurement. §2.3 records
  only that it has none today, which is what makes the slice's coverage rule a gate rather than a
  capability.
- The `drugstore`/`pharmacy` retrieval split in §5.3. It is recorded as evidence. Ranking and retrieval
  behavior are unchanged by this record, and any repair is separate work with its own D-rule
  obligations.

---

## 8. How the numbers here were taken

So a reader can re-run them rather than trust them.

- **Vocabulary counts** (§2.1, §4): read directly from
  `packages/poi-taxonomy/data/curated-overlay.json` and
  `packages/poi-taxonomy/data/taxonomy.json`. The six categories declaring `overtureCategories` are
  `bank`, `cafe`, `place_of_worship`, `school`, `supermarket`, `trail`.
- **Subject-match table** (§5.2): each query passed to `matchPOISubject` from
  `@mailwoman/kind-classifier` with the shipped `poiTaxonomyLookup` from
  `packages/mailwoman/poi-intent.ts` and the locale shown. No model, no database, no network — the
  lexicon probe is the whole mechanism under test.
- **Layer counts and coverage** (§2.3, §5.3): one read-only `node:sqlite` pass over the shipped
  `poi.db` at `dataRootPath("poi", "poi.db")`, joining `poi.category_id` through
  `poi_category_codes`, plus `select basis, count(*), min(completeness), max(completeness) from
layer_coverage group by basis` and the single-row `layer_manifest`. One `group by category_id,
country` scan produces every category figure at once; the artifact is sealed and read-only, so the
  measurement cannot disturb it.

Re-measure before reusing any figure here: `poi.db` is a rebuilt, sealed artifact, and its manifest
version is the thing to compare against (`2026-07-22.0` at the time of writing).
