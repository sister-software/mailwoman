# @mailwoman/geographic-model

The **world-semantic layer**: stable geographic concepts, the relations between them, mappings from external vocabularies into those concepts, source observations, derived facts, and the provenance of every one of them — authored as records, compiled deterministically into runtime artifacts.

> **Status: scaffold.** The public entry point is empty on purpose. The authored-record schema arrives with #1925 and the deterministic compiler with #1926. Ownership is settled here; shape is not.

The ownership boundary is fixed by the record at [`docs/superpowers/specs/2026-08-26-geographic-model-boundaries.md`](../../docs/superpowers/specs/2026-08-26-geographic-model-boundaries.md) (#1917), under program parent #1916. That document is authoritative for everything below; this README is the package-local summary.

## What this package owns

- Stable concepts beyond the POI vocabulary, and the identifiers other packages refer to them by.
- Relation definitions, activities, affordances, and rule modality — the first of which is one proposition: `pharmacy affords obtain_medication`.
- Mappings from external vocabularies (`@mailwoman/poi-taxonomy` category identifiers, and later others) into world concepts.
- Source observations, kept separate from derived facts.
- Derivation provenance on every mapping and every derived fact.
- Deterministic compilation of the authored records into runtime artifacts, and the validation that refuses a record set which does not compile.

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

## Why this is not in the release list

`@mailwoman/geographic-model` is a public, publishable-shaped workspace, and it is deliberately absent from `.release-it.json`'s workspace list. The reason is mechanical rather than editorial: **npm Trusted Publishing cannot create a package that does not exist yet.** A brand-new `@mailwoman/*` name returns `E404` from OIDC, so it needs a one-time manual first publish plus a Trusted Publisher configuration — `scripts/bless-package.ts`, an interactive second-factor step an operator runs — before CI can ever publish it. Adding the name to the release list ahead of that blessing does not publish the package; it fails the next coordinated release at this workspace. `RELEASING.md`'s "Adding a NEW package: it can't be first-published from CI" is the full account.

The absence is therefore recorded, not silent: `SANCTIONED_RELEASE_ABSENCES` in [`scripts/release-stage.ts`](../../scripts/release-stage.ts) carries it with that reason, and `checkReleaseListIdentity` fails on any absence missing from that record. The version stays at `0.0.0` — nothing bumps a workspace outside the release list, and `0.0.0` reads as never published, which is the true statement.

When the package is blessed and its Trusted Publisher is on file, the change is three edits in one commit: add `packages/geographic-model` to `.release-it.json`, remove its entry from `SANCTIONED_RELEASE_ABSENCES`, and update the arithmetic in `AGENTS.md` and `scripts/release-stage.test.ts`.

## Layout

Source lives at the workspace root, as it does in every workspace except `packages/corpus/` and `docs/`. Tests live under `test/unit/` and reach the package through its package name, never a relative path — the contract `scripts/verify-test-contract.ts` enforces.

The manifest's `files` array already declares `data/**/*.json`. Authored records land there, and a glob written now cannot be the one a later publish forgets: `**/*.ts` does not cover JSON, and a data file absent from `files` is a package that installs without the data it exists to carry.

## License

AGPL-3.0-only OR LicenseRef-Commercial. See the repository root for details.
