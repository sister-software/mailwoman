# @mailwoman/geographic-model

Authored geographic semantics for the [mailwoman](https://www.npmjs.com/package/mailwoman) geocoder: stable concepts (`pharmacy`, `obtain_medication`), the relations a curator can state between them (`pharmacy affords obtain_medication`), mappings into external vocabularies, source observations, and derived facts. Every record carries provenance, and the package compiles all of it deterministically into a lookup artifact that the runtime reads.

A geocoder benefits from knowing that a pharmacy is a place where you obtain medication. Once that knowledge becomes a ranking rule, however, authored opinion starts overriding what the models learned from data. This package stores the knowledge in a shape that cannot become ranking policy. The schema has no numeric field, and the compiled artifact answers lookups and never orderings.

## Should you install this?

You probably should not install it directly yet.

- If you want a geocoder, install [`mailwoman`](https://www.npmjs.com/package/mailwoman). It uses this package where its experiments need it.
- **Do not depend on version `0.0.0`.** That version exists to reserve the package name. The first supported release ships with the next coordinated mailwoman release, and the API is unstable until a `1.x`.
- You can evaluate the schema, the validator, the compiler, and the committed artifact today. All of them ship as readable TypeScript source and JSON in this repository.

## The shape of the data

One document holds six tables, and all six are required. A hand-authored file writes `"derivedFacts": []` instead of leaving the table out, because an absent table and an empty table make different claims.

| Table          | Record                                  | What it is                                                                                                                            |
| -------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `relations`    | `RelationRecord`                        | Vocabulary: what a relation means, which concept kinds may stand on each side, whether it is transitive or symmetric, and its inverse |
| `concepts`     | `ConceptRecord` + `RelationAssertion[]` | Authored semantics: a concept, its broader concepts, and the claims a curator states about it                                         |
| `mappings`     | `ExternalMappingRecord`                 | Translation into an external vocabulary — today `@mailwoman/poi-taxonomy` category identifiers                                        |
| `observations` | `SourceObservationRecord`               | What a named external source states, recorded in this vocabulary and kept out of the concept table                                    |
| `derivedFacts` | `DerivedFactRecord`                     | What a named procedure computed, with every record it read listed as an input. Written by the compiler, never by hand                 |

Three properties hold by construction:

- **The schema has no numeric field.** It has no strength, confidence, or count. `Modality` is an ordinal vocabulary of words (`necessary`, `prohibited`, `strongly_expected`, … `strongly_unusual`), and the package exports no order over it, because a number on an authored relationship acts as a ranking weight whatever it is called.
- **Authored, observed, and derived records are three distinct types.** Their identifiers carry separate brands, so one cannot be assigned where another is expected. They live in separate tables, so a curator must make each curation decision deliberately instead of relying on where a record happens to sit.
- **A derived fact carries its provenance in its structure.** It has no `source` field. Its `derivation` and its `inputs` form the provenance, and every input carries source provenance in turn. A source string can be copied onto a record that did not come from that source, but an input list must resolve or the document fails validation.

Identifiers are branded through `type-fest`'s `Tagged` and converted explicitly with `toConceptID`, `toRelationID`, `toRuleID`, `toMappingID`, `toObservationID`, and `toDerivedFactID`. The brands exist only at compile time, and the strings pass through JSON unchanged.

## The validator

`validateGeographicModelDocument(input)` returns either the whole document or every reason it is invalid. `parseGeographicModelDocument(input)` is the throwing form. Its `GeographicModelValidationError` states every violation in `error.message` as well as on `error.issues`, so a caller that only prints the message still sees all of them.

The validator reports **every** violation, each with a JSONPath-style location such as `$.concepts[0].assertions[1].modality`. It never returns a partial document. If a validator silently dropped the records it could not read, its output would look the same as a world that did not contain those records.

The validator runs two passes, and both always run. The **shape** pass covers field presence and types, closed-vocabulary membership, and unknown keys. A field whose name suggests ranking policy (`score`, `boost`, `penalty`, `rankWeight`, and anything else matching the same fragments) is reported under its own code instead of as an anonymous stray field. The **whole-table references** pass covers duplicate identifiers, `isA` self-reference and cycles, relation and concept resolution, relation domain and range kinds, inverse reciprocity, and derivation inputs.

The validator is plain deterministic TypeScript with no I/O. It uses no reasoner, query engine, or schema library.

## The loader, the compiler, and the artifact

`loadGeographicModelDirectory(root)` reads every `*.json` file under a directory and merges them into one document. It lives in the `./load` subpath and is the only module here that touches a filesystem. The file layout is an authoring convenience and carries no meaning. Enumeration order cannot affect the output, and every validation issue identifies the file it came from.

`compileGeographicModel(input)` delegates validation and then compiles. **`isA` alone defines semantic inheritance.** The artifact carries every concept's transitive ancestors, and it copies every ancestor's assertions onto descendants as derived facts that record their derivation and inputs. The compiler does **not** compute closures for a relation that declares `transitive` or `inverse`. Those fields describe what the relation means, and general reasoning is excluded from this package for its lifetime.

`serializeCompiledModel(model)` produces canonical bytes. Keys appear in code-point order at every depth, tables are ordered by identifier, and no field records when compilation ran. Two builds of one document are byte-identical, so regenerating produces a diff only when the records changed.

`createGeographicModelIndex(model)` in the `./lookup` subpath is the read interface: `concept`, `relation`, `ancestorsOf`, `derivedFactsAbout`, `conceptsForExternalID`. It supports lookups only, without walks, cursors, or a query language, because the artifact exists to remove query-time traversal. Two kinds of absence stay distinguishable. A concept that the artifact does not carry answers `undefined`, and a carried concept with no derived facts answers an empty list.

## What is authored today

The first record set is in [`data/model/`](./data/model/):

```text
place
establishment          isA place
healthcare_facility    isA establishment
pharmacy               isA healthcare_facility          affords obtain_medication   (necessary)
activity
obtain_medication      isA activity

affords                establishment → activity, neither transitive nor symmetric
poi-taxonomy pharmacy  → the pharmacy concept
```

[`data/geographic-model.json`](./data/geographic-model.json) is the committed compilation. **Do not hand-edit it.** Regenerate it instead:

```bash
node packages/geographic-model/lib/scripts/build-artifact.ts && npx oxfmt packages/geographic-model/data/geographic-model.json
```

[`data/PROVENANCE.md`](./data/PROVENANCE.md) records what each file states and where each external category id was read from. A reviewed amendment added a first breadth wave: a `drugstore` concept, a US-scoped `affords` assertion on it, and a second `poi-taxonomy` mapping. All three are authored under the same provenance rules. One activity therefore reaches two establishment classes. The schema was designed to express that case, and the POI branch searches the two classes as a union.

In a measurement, this one proposition was injected behind an off-by-default flag. Activity-phrased queries against the live geocoder went from 0 of 4 answered to 3 of 4 (a pharmacy 0.41 km from the Denver anchor), and all 6 control queries were unchanged. The measurement was pre-registered before the code existed, frozen by hash, and judged against committed thresholds. Its result is why the package continues to grow.

## Design commitments

Each of these concerns belongs to another package. Listing the owner prevents a second copy from growing here.

| Not here                                                                                                     | Owner                                                                                                    |
| ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| Relevance weights, boosts, penalties, any candidate-ordering API — even a type                               | `@mailwoman/resolver` (ordering), `@mailwoman/neural` + `@mailwoman/core/decoder` (the decode objective) |
| POI categories, their containment hierarchy, the Overture-leaf translation, the query-phrase lexicon, brands | `@mailwoman/poi-taxonomy`                                                                                |
| Dataset identity and coverage epistemics                                                                     | `@mailwoman/core/layers`                                                                                 |
| Empirical, spatial activity-affordance statistics                                                            | Fitted from data elsewhere in the program, against the identifiers owned here                            |

Tests enforce two rules. First, `@mailwoman/core` must not depend on this package. Core ships the pipeline interface plus ~9 MB of reference data to every consumer, so every drop-in API would inherit a world-semantics dependency added there. Second, the public API carries no ranking policy. A binding whose name suggests a boost, penalty, weight, rank, score, or ordering fails the suite.

One rule governs the whole boundary: **knowledge creates observations; it never overrides learned interpretation.** A record here may create a fact, an anomaly, a contradiction, or a coverage-qualified absence. It may not create an imperative.

The package architecture excludes the following for its whole life: an OWL/DL reasoner, a SPARQL endpoint, a triplestore, a general-purpose knowledge-graph service, and any query-time traversal of the authoring JSON. Authored records are source material that compiles into artifacts, and the package provides no service.

## Where the full design lives

This README is the package-local summary. The authoritative documents are in the mailwoman repository:

- The ownership boundary and the frozen first record set: [`docs/superpowers/specs/2026-08-26-geographic-model-boundaries.md`](https://github.com/sister-software/mailwoman/blob/main/docs/superpowers/specs/2026-08-26-geographic-model-boundaries.md)
- The program that governs growth, with its decision points: [sister-software/mailwoman#1916](https://github.com/sister-software/mailwoman/issues/1916)

## Layout

Source lives at the workspace root. Tests live under `test/unit/` and import the package by its package name, never by a relative path. The manifest's `files` array declares `data/**/*.json` explicitly. `**/*.ts` does not match JSON, and a data file missing from `files` would leave the installed package without the data it exists to carry.

## License

AGPL-3.0-only OR LicenseRef-Commercial. See the repository root for details.
