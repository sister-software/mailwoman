# @mailwoman/evidence

This package defines evidence records and the claims they support. It provides TypeScript types, Zod schemas and constructors for observations, relations, priors and exclusions.

Public library. Install with `npm install @mailwoman/evidence`.

## Quick start

```ts
import { Assertion, EvidenceSchema, observation, prior, relation } from "@mailwoman/evidence"

const observed = observation("example-register", null, { locality: "Paris" })
const membership = relation({
	source: "example-register",
	vintage: "2026-01-01",
	relationship: "locality belongs to region",
	assertion: Assertion.Authoritative,
})
const preference = prior("example-model", "locality", 0.8)

EvidenceSchema.parse(observed)
console.log(membership.score) // null
console.log(preference.kind) // "prior"
```

The source names above are illustrative. An observation's `vintage: null` means
the source did not record a date.

## Evidence kinds

| Kind          | Meaning                                                                                           |
| ------------- | ------------------------------------------------------------------------------------------------- |
| `observation` | A value retrieved from an identified source, with a recorded vintage or an explicit unknown date. |
| `relation`    | A relationship stated by a source or inferred by a consumer.                                      |
| `prior`       | A weight used to adjust probability. It cannot establish an exclusion.                            |
| `exclusion`   | Negative evidence with an explicit coverage basis and normalization identity.                     |

Use `relation()` to enforce the rule that an authoritative relationship has no
score. The constructor throws if an authoritative input supplies a score.
An inferred relationship may supply one. The Zod schemas describe the serialized
shapes, but `RelationSchema` does not enforce this constructor check.

## Coverage and exclusions

`requireExclusionBasis()` returns an exclusion only when the supplied coverage
cell has a `designated` or `surveyed` basis and the probe and layer use the same
normalization identity. It returns `null` for a missing cell, a
`source_present` basis, differing identities, or a supplied country outside the
supplied country set.

A normalization identity records a function's outputs over `FOLD_PROBE_CORPUS`.
Compute it with `foldIdentity(normalize)` for both the build and lookup functions.
The helper compares these identities. It does not independently measure coverage
or establish that two functions agree on every possible input.

## Claims and derivations

`EpistemicStatus` distinguishes `designated`, `observed`, `derived`,
`inferred` and `unresolved` values. `Assertion` distinguishes authoritative
and inferred relationships. `AssertedProposition` identifies the field-level
claim, such as identity, address or geometry.

`projectDerivation({ status, nodes, uncertaintyM })` packages the evidence and
each constraint's contribution. It freezes the projection and copies of the
constraint nodes. Nested evidence objects are not recursively frozen.
Use `uncertaintyM: null` when the uncertainty radius is unknown.

The package root exports the schemas, types and helpers from
[`evidence`](lib/evidence.ts), [`coverage`](lib/coverage.ts),
[`status`](lib/status.ts) and [`derivation`](lib/derivation.ts).

## License

The package declares `AGPL-3.0-only OR LicenseRef-Commercial`.
