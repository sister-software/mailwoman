# @mailwoman/geographic-model

The **world-semantic layer**: stable geographic concepts, the relations between them, mappings from external vocabularies into those concepts, source observations, derived facts, and the provenance of every one of them — authored as records, compiled deterministically into runtime artifacts.

> **Status: one authored proposition.** The record types and their deterministic validator are here (#1925), along with the loader and compiler that turn authored files into a runtime artifact (#1926) and the first authored document — `pharmacy affords obtain_medication` (#1927). Nothing consumes the artifact at runtime: no resolver integration, no ordering change, no POI behavior change. Whether the proposition is worth anything to a user is what #1928's pre-registered probe measures, and #1930 records the decision.

The ownership boundary is fixed by the record at [`docs/superpowers/specs/2026-08-26-geographic-model-boundaries.md`](../../docs/superpowers/specs/2026-08-26-geographic-model-boundaries.md) (#1917), under program parent #1916. That document is authoritative for everything below; this README is the package-local summary.

## What this package owns

- Stable concepts beyond the POI vocabulary, and the identifiers other packages refer to them by.
- Relation definitions, activities, affordances, and rule modality — the first of which is one proposition: `pharmacy affords obtain_medication`.
- Mappings from external vocabularies (`@mailwoman/poi-taxonomy` category identifiers, and later others) into world concepts.
- Source observations, kept separate from derived facts.
- Derivation provenance on every mapping and every derived fact.
- Deterministic compilation of the authored records into runtime artifacts, and the validation that refuses a record set which does not compile.

## The schema

One document holds six tables, and all six are required — a hand-authored file writes `"derivedFacts": []` rather than leaving the table out, because an absent table and an empty table are different claims.

| Table          | Record                                  | What it is                                                                                                                            |
| -------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `relations`    | `RelationRecord`                        | Vocabulary: what a relation means, which concept kinds may stand on each side, whether it is transitive or symmetric, and its inverse |
| `concepts`     | `ConceptRecord` + `RelationAssertion[]` | Authored semantics: a concept, its broader concepts, and the claims a curator states about it                                         |
| `mappings`     | `ExternalMappingRecord`                 | Translation into an external vocabulary — today `@mailwoman/poi-taxonomy` category identifiers                                        |
| `observations` | `SourceObservationRecord`               | What a named external source states, recorded in this vocabulary and kept out of the concept table                                    |
| `derivedFacts` | `DerivedFactRecord`                     | What a named procedure computed, with every record it read listed as an input. Written by the compiler, never by hand                 |

Three properties hold by construction:

- **No numeric field exists anywhere.** Not a strength, not a confidence, not a count. `Modality` is an ordinal vocabulary of words (`necessary`, `prohibited`, `strongly_expected`, … `strongly_unusual`) and the package exports no order over it, because a number on an authored relationship is a ranking weight whatever it is called.
- **Authored, observed, and derived are three types, not three uses of one type.** Their identifiers carry separate brands, so one is not assignable where another is expected, and they live in separate tables so a curation decision has to be made deliberately rather than by a record sitting in a convenient place.
- **A derived fact carries its provenance structurally.** It has no `source` field: its `derivation` plus its `inputs` are the provenance, and every input carries source provenance in turn. A source string can be copied onto a record that did not come from it; an input list either resolves or the document does not validate.

Identifiers are branded through `type-fest`'s `Tagged` and converted explicitly — `toConceptID`, `toRelationID`, `toRuleID`, `toMappingID`, `toObservationID`, `toDerivedFactID` — the same idiom as `toPOICategoryID` in `@mailwoman/poi-taxonomy`. The brands are compile-time only; the strings survive JSON untouched.

## The validator

`validateGeographicModelDocument(input)` returns the whole document or every reason it is not one. `parseGeographicModelDocument(input)` is the throwing form, and its `GeographicModelValidationError` states every violation in `error.message` as well as on `error.issues`, so a caller that only prints the message still sees all of them.

It reports **every** violation, each addressed by a JSONPath-style location such as `$.concepts[0].assertions[1].modality`. It never returns a partial document: a validator that quietly drops the records it could not read is a validator whose output is indistinguishable from a world that does not contain them.

Two passes, both of which always run. **Shape** covers field presence and types, closed-vocabulary membership, and unknown keys — with a field whose name announces ranking policy (`score`, `boost`, `penalty`, `rankWeight`, `relevanceWeight`, `affinityWeight`, and anything else matching the same fragments) reported under its own code rather than as an anonymous stray field. **Whole-table references** covers duplicate identifiers, `isA` self-reference and cycles, relation and concept resolution, relation domain and range kinds, inverse reciprocity, and derivation inputs.

It is plain deterministic TypeScript with no I/O and no dependencies beyond the two type imports: no reasoner, no query engine, no schema library.

## The loader

`loadGeographicModelDirectory(root)` (the `./load` subpath, the one module here that touches a filesystem) reads every `*.json` file under a directory and merges them into one document.

**The layout is authoring convenience and carries no meaning.** A concept means the same thing whichever file it was written in, and a file may hold any subset of the tables. One file is special: `model.json`, holding the document's `version` — a version assembled from whichever fragment happened to declare one is a version nobody chose.

Two properties make it safe to build an artifact from:

- **Enumeration order cannot reach the output.** The files are sorted by path before any of them is read, so the merged tables are a function of the file names and their contents, never of `readdir` order. `mergeGeographicModelFiles(files)` states the same property without a filesystem, which is how it is tested: any order in, one document out.
- **Every issue names the file it came from.** The validator addresses a record by its position in the merged table (`$.concepts[7].kind`) — the one address an author cannot see — so the loader keeps a per-record origin and re-addresses each issue. A duplicate identifier names **both** files, the one that claimed it and the one that claimed it first, because "already used" is unactionable without the other half.

What the loader checks on its own is only what the validator cannot see: whether a file parses, whether it is an object, and whether the keys it uses are tables. Everything else is delegated whole.

## The compiler

`compileGeographicModel(input)` validates by delegation — `parseGeographicModelDocument` decides whether a document is well formed, and throws with every violation before a byte is computed — then compiles it into a `CompiledGeographicModel`. There is no second validator, and no partial artifact: a compile produces the whole thing or produces nothing.

**`isA` alone defines semantic inheritance**, and two derivations follow from it:

| In the artifact      | What it is                                                                                                                                                     |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inheritanceClosure` | Every concept's transitive `isA` ancestors, deduplicated and ordered. One entry per concept, empty list included — a concept that is a kind of nothing says so |
| `derivedFacts`       | Every ancestor's assertions materialized onto its descendants as `DerivedFactRecord`s, naming the derivation and every record it read                          |

Materializing the assertions is what makes the artifact answer a question rather than point at one: the closure alone would tell a consumer which concepts to go and read, which is the traversal it was supposed to be spared. A descendant that states the same relation and target itself inherits nothing for that pair — the authored record is the more specific one, which is what `isA` means.

A relation declaring `transitive` or `inverse` is **not** closed over. Those fields say what the relation means; materializing them is a reasoning step no executable need has asked for, and general reasoning is excluded from this package. The day one is needed it arrives as its own named derivation beside this one.

Compilation refuses two things the validator cannot see, both about records the compiler is about to write, and both reported with every offending record named: an inherited assertion whose subject kind the relation does not accept, and two derived facts claiming one identifier.

## The artifact

`serializeCompiledModel(model)` produces the canonical bytes. Two rules define them:

- **Every object's keys are emitted in code-point order**, at every depth. A rule that canonicalizes by itself beats a hand-kept field order, which drifts the first time the schema gains a field.
- **Every table is ordered by identifier**, under `compareIdentifiers` — code point, never `localeCompare`, whose answer depends on the machine's collation. Arrays inside a record keep the order they were authored in.

Nothing records when compilation ran: `modelVersion` is the authored document's own version, so two builds of one document are byte-identical and a regenerate is a diff only when the records changed. `schemaVersion` is the artifact FORMAT version, and `parseCompiledGeographicModel` refuses an artifact declaring another one rather than reading fields that may have moved.

A committed artifact is these bytes run through `oxfmt`, which inlines short arrays — the same convention `taxonomy.json` follows. So a freshness check compares the **parsed** artifact against a fresh compile, and a byte comparison compares two compiles.

`createGeographicModelIndex(model)` (the `./lookup` subpath) is the read surface: `concept`, `relation`, `ancestorsOf`, `derivedFactsAbout`, `conceptsForExternalID`. Lookups only — no walk, no cursor, no query language, because removing query-time traversal is the reason the artifact exists. Two absences stay distinguishable throughout: a concept the artifact does not carry answers `undefined`, and a concept it carries with nothing derived about it answers an empty list.

## The authored slice

One proposition, frozen by §4 of the boundary record and authored under [`data/model/`](./data/model/):

```text
place
establishment          isA place
healthcare_facility    isA establishment
pharmacy               isA healthcare_facility          affords obtain_medication   (necessary)
activity
obtain_medication      isA activity

affords                establishment → activity, hard, not transitive, not symmetric
poi-taxonomy pharmacy  → the pharmacy concept
```

Every concept, assertion and mapping carries `provenance` naming the boundary record and #1927 — the two authorities this slice has. `RelationRecord` carries none, because a relation is vocabulary rather than a claim: it says what `affords` means, and stands behind nothing in particular.

Deliberately absent, and each absence is a statement rather than an omission: no source observations, no hand-authored derived facts, no `countries` scope, and no second establishment class. `isA` inheritance materializes nothing here, because the one assertion sits on `pharmacy` and `pharmacy` has no descendants.

[`data/geographic-model.json`](./data/geographic-model.json) is the committed compilation of those records. **Do not hand-edit it** — regenerate:

```bash
node packages/geographic-model/scripts/build-artifact.ts && npx oxfmt packages/geographic-model/data/geographic-model.json
```

[`data/PROVENANCE.md`](./data/PROVENANCE.md) records what each file states, where the external category id was read from, and why the freshness check compares parsed values. `test/unit/pharmacy-slice.test.ts` asserts all of it against the committed artifact, and names that command when the artifact goes stale.

## What this package must never own

Each of these is owned elsewhere, and naming the owner is what keeps a second copy from growing here.

| Not here                                                                                                     | Owner                                                                                                    |
| ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| Relevance weights, boosts, penalties, any candidate-ordering API — even a type                               | `@mailwoman/resolver` (ordering), `@mailwoman/neural` + `@mailwoman/core/decoder` (the decode objective) |
| POI categories, their containment hierarchy, the Overture-leaf translation, the query-phrase lexicon, brands | `@mailwoman/poi-taxonomy`                                                                                |
| Dataset identity and coverage epistemics                                                                     | `@mailwoman/core/layers`                                                                                 |
| Empirical, spatial activity-affordance statistics                                                            | #1683 — it fits numbers against the identifiers owned here                                               |

Two rules follow from that table and are enforced rather than assumed:

- **`@mailwoman/core` must not depend on `@mailwoman/geographic-model`.** Core ships the pipeline contract and roughly 9 MB of reference data to every consumer, so a world-semantics dependency there is one every drop-in API inherits without asking for it. [`test/unit/boundaries.test.ts`](./test/unit/boundaries.test.ts) reads core's manifest and fails on the day that changes.
- **The public surface carries no ranking policy.** The same test reads whatever the entry point exports and refuses a binding whose name announces a boost, a penalty, a weight, a rank, a score, or an ordering.

The operating rule for the whole boundary is one sentence, verbatim from the record: **knowledge creates observations; it never overrides learned interpretation.** A record here may create a fact, an anomaly, a contradiction, or a coverage-qualified absence. It may not create an imperative.

Architecturally excluded for the life of the program, not merely deferred: an OWL/DL reasoner, a SPARQL endpoint, a triplestore, a general-purpose knowledge-graph service, and any query-time traversal of the authoring JSON. Authored records are source material compiled into artifacts — artifacts, not a service.

## Release posture

`@mailwoman/geographic-model` is in `.release-it.json`'s workspace list and releases with its siblings. The npm name exists (a token `0.0.0` first publish plus a Trusted Publisher configuration, the `scripts/bless-package.ts` flow — required because npm Trusted Publishing cannot create a package that does not exist yet; `RELEASING.md`'s "Adding a NEW package: it can't be first-published from CI" is the full account). The version reads `0.0.0` until the next coordinated release bumps it — consumers should depend on the first released version, not the token publish, which carries no compiled `out/`.

## Layout

Source lives at the workspace root, as it does in every workspace except `packages/corpus/` and `docs/`. Tests live under `test/unit/` and reach the package through its package name, never a relative path — the contract `scripts/verify-test-contract.ts` enforces.

The manifest's `files` array already declares `data/**/*.json`. Authored records land there, and a glob written now cannot be the one a later publish forgets: `**/*.ts` does not cover JSON, and a data file absent from `files` is a package that installs without the data it exists to carry.

## License

AGPL-3.0-only OR LicenseRef-Commercial. See the repository root for details.
