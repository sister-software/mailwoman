# @mailwoman/geographic-model

Authored geographic semantics for the [mailwoman](https://www.npmjs.com/package/mailwoman) geocoder: stable concepts (`pharmacy`, `obtain_medication`), the relations a curator can state between them (`pharmacy affords obtain_medication`), mappings into external vocabularies, source observations, and derived facts — every record carrying provenance, and all of it compiled deterministically into a lookup artifact the runtime reads.

The design problem it exists to solve: a geocoder benefits from knowing that a pharmacy is a place where you obtain medication, but the moment that knowledge becomes a ranking rule, authored opinion starts overriding what the models learned from data. This package holds the knowledge in a shape that CANNOT become ranking policy — no numeric field exists anywhere in the schema, and the compiled artifact answers lookups, never orderings.

## Should you install this?

Probably not directly — not yet.

- If you want a geocoder, install [`mailwoman`](https://www.npmjs.com/package/mailwoman). It consumes this package where its experiments call for it.
- **Version `0.0.0` on npm is a name reservation**, published to establish the package for npm Trusted Publishing. It carries no compiled output. The first usable release ships with the next coordinated mailwoman release, and the API is unstable until a `1.x`.
- What you can evaluate today: the schema, the validator, the compiler, and the committed artifact — all shipped as readable TypeScript source and JSON in this repository.

## The shape of the data

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

Identifiers are branded through `type-fest`'s `Tagged` and converted explicitly — `toConceptID`, `toRelationID`, `toRuleID`, `toMappingID`, `toObservationID`, `toDerivedFactID`. The brands are compile-time only; the strings survive JSON untouched.

## The validator

`validateGeographicModelDocument(input)` returns the whole document or every reason it is not one. `parseGeographicModelDocument(input)` is the throwing form, and its `GeographicModelValidationError` states every violation in `error.message` as well as on `error.issues`, so a caller that only prints the message still sees all of them.

It reports **every** violation, each addressed by a JSONPath-style location such as `$.concepts[0].assertions[1].modality`. It never returns a partial document: a validator that drops the records it could not read, without reporting them, is a validator whose output is indistinguishable from a world that does not contain them.

Two passes, both of which always run. **Shape** covers field presence and types, closed-vocabulary membership, and unknown keys — with a field whose name announces ranking policy (`score`, `boost`, `penalty`, `rankWeight`, and anything else matching the same fragments) reported under its own code rather than as an anonymous stray field. **Whole-table references** covers duplicate identifiers, `isA` self-reference and cycles, relation and concept resolution, relation domain and range kinds, inverse reciprocity, and derivation inputs.

It is plain deterministic TypeScript with no I/O: no reasoner, no query engine, no schema library.

## The loader, the compiler, and the artifact

`loadGeographicModelDirectory(root)` (the `./load` subpath, the one module here that touches a filesystem) reads every `*.json` file under a directory and merges them into one document. The file layout is authoring convenience and carries no meaning; enumeration order cannot reach the output, and every validation issue names the file it came from.

`compileGeographicModel(input)` validates by delegation, then compiles. **`isA` alone defines semantic inheritance**: the artifact carries every concept's transitive ancestors and every ancestor's assertions materialized onto descendants as derived facts naming their derivation and inputs. A relation declaring `transitive` or `inverse` is **not** closed over — those fields say what the relation means, and general reasoning is excluded from this package for its lifetime.

`serializeCompiledModel(model)` produces canonical bytes: keys in code-point order at every depth, tables ordered by identifier, and nothing recording when compilation ran — two builds of one document are byte-identical, so a regenerate is a diff only when the records changed.

`createGeographicModelIndex(model)` (the `./lookup` subpath) is the read surface: `concept`, `relation`, `ancestorsOf`, `derivedFactsAbout`, `conceptsForExternalID`. Lookups only — no walk, no cursor, no query language, because removing query-time traversal is the reason the artifact exists. Two absences stay distinguishable throughout: a concept the artifact does not carry answers `undefined`, and a concept it carries with nothing derived about it answers an empty list.

## What is authored today

The first slice, in [`data/model/`](./data/model/):

```text
place
establishment          isA place
healthcare_facility    isA establishment
pharmacy               isA healthcare_facility          affords obtain_medication   (necessary)
activity
obtain_medication      isA activity

affords                establishment → activity, not transitive, not symmetric
poi-taxonomy pharmacy  → the pharmacy concept
```

[`data/geographic-model.json`](./data/geographic-model.json) is the committed compilation. **Do not hand-edit it** — regenerate:

```bash
node packages/geographic-model/scripts/build-artifact.ts && npx oxfmt packages/geographic-model/data/geographic-model.json
```

[`data/PROVENANCE.md`](./data/PROVENANCE.md) records what each file states and where the external category id was read from. A reviewed amendment has admitted a first breadth wave (a `drugstore` concept with a US-scoped assertion and its mapping); the records land under the same provenance discipline.

Measured, not promised: with this one proposition injected behind an off-by-default flag, activity-phrased queries against the live geocoder moved from 0 of 4 answered to 3 of 4 (a pharmacy 0.41 km from the Denver anchor), with all 6 control queries unchanged. That measurement — pre-registered before the code existed, frozen by hash, decided against committed thresholds — is why the package continues to grow.

## Design commitments

Each of these is owned elsewhere, and naming the owner is what keeps a second copy from growing here.

| Not here                                                                                                     | Owner                                                                                                    |
| ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| Relevance weights, boosts, penalties, any candidate-ordering API — even a type                               | `@mailwoman/resolver` (ordering), `@mailwoman/neural` + `@mailwoman/core/decoder` (the decode objective) |
| POI categories, their containment hierarchy, the Overture-leaf translation, the query-phrase lexicon, brands | `@mailwoman/poi-taxonomy`                                                                                |
| Dataset identity and coverage epistemics                                                                     | `@mailwoman/core/layers`                                                                                 |
| Empirical, spatial activity-affordance statistics                                                            | Fitted from data elsewhere in the program — against the identifiers owned here                           |

Two rules are enforced by tests rather than assumed: `@mailwoman/core` must not depend on this package (core ships the pipeline contract plus ~9 MB of reference data to every consumer, and a world-semantics dependency there is one every drop-in API inherits without asking), and the public surface carries no ranking policy — a binding whose name announces a boost, penalty, weight, rank, score, or ordering fails the suite.

The operating rule for the whole boundary is one sentence: **knowledge creates observations; it never overrides learned interpretation.** A record here may create a fact, an anomaly, a contradiction, or a coverage-qualified absence. It may not create an imperative.

Architecturally excluded for the life of the package: an OWL/DL reasoner, a SPARQL endpoint, a triplestore, a general-purpose knowledge-graph service, and any query-time traversal of the authoring JSON. Authored records are source material compiled into artifacts — artifacts, not a service.

## Where the full design lives

This README is the package-local summary. The authoritative documents are in the mailwoman repository:

- The ownership boundary and the frozen first slice: [`docs/superpowers/specs/2026-08-26-geographic-model-boundaries.md`](https://github.com/sister-software/mailwoman/blob/main/docs/superpowers/specs/2026-08-26-geographic-model-boundaries.md)
- The program that governs growth, with its decision points: [sister-software/mailwoman#1916](https://github.com/sister-software/mailwoman/issues/1916)

## Layout

Source lives at the workspace root. Tests live under `test/unit/` and reach the package through its package name, never a relative path. The manifest's `files` array declares `data/**/*.json` explicitly — `**/*.ts` does not cover JSON, and a data file absent from `files` is a package that installs without the data it exists to carry.

## License

AGPL-3.0-only OR LicenseRef-Commercial. See the repository root for details.
