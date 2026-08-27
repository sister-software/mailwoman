# `data/` provenance

## `model/` — the authored records

The authoring source for the frozen pharmacy slice and the wave-1 breadth records amended onto it. Seven concepts, one
relation, two external mappings, two assertions. Authored by hand; edit these and regenerate the artifact below.

- **Authority:** [`docs/superpowers/specs/2026-08-26-geographic-model-boundaries.md`](../../../docs/superpowers/specs/2026-08-26-geographic-model-boundaries.md)
  §4 — the frozen vertical slice (#1917), and issue #1927, whose Scope block lists the concepts and the relation
  verbatim. Both are named in every record's `provenance`; no third-party source contributed anything here.
- **Authored:** 2026-08-26.
- **Layout:** the loader reads every `*.json` file under `model/` and merges them, so the file boundaries are
  authoring convenience. `model.json` is the one exception — it holds the document's `version`, and nothing else.
- **Not authored:** no source observations, and no hand-authored derived facts. Both tables therefore compile empty,
  which is the truthful answer for this slice rather than an unread one: nothing external was recorded, and the one
  assertion sits on `pharmacy`, which has no descendants for `isA` inheritance to materialize onto.

### What each record states

| File             | Record                                                                                                    | Reading                                                                                                                                                                                           |
| ---------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `relations.json` | `affords`                                                                                                 | `establishment` → `activity`, not transitive, not symmetric, `defeasible` semantics — an exception qualifies a record rather than falsifying the set                                              |
| `concepts.json`  | `place`, `establishment`, `healthcare_facility`, `pharmacy`, `drugstore`, `activity`, `obtain_medication` | the `isA` chain the slice names, and two assertions: `pharmacy affords obtain_medication` (`necessary`, unscoped) and `drugstore affords obtain_medication` (`strongly_expected`, scoped to `US`) |
| `mappings.json`  | `poi-taxonomy-pharmacy`, `poi-taxonomy-drugstore`                                                         | `@mailwoman/poi-taxonomy` categories `pharmacy` and `drugstore` name the concepts of the same names                                                                                               |

Identifiers are bare (`pharmacy`, not `mw:pharmacy`). The issue writes the `mw:` prefix as namespace notation in prose;
a literal colon inside a concept identifier would collide with the separator `compileGeographicModel` builds derived
identifiers from, which is a collision its `duplicate_derived_fact_id` refusal exists to catch.

`modality: "necessary"` on the pharmacy assertion is grounded in the concept: dispensing medication to the public is
what makes premises a pharmacy, so a counter-example falsifies that record instead of qualifying it. It carries no
`countries` scope, which is the weaker statement the schema says it is. The drugstore assertion is the other half of
the country-conditional question — which OTHER establishment classes afford the activity, and where — and it is
`strongly_expected` and scoped to `US`, which is why the relation reads `defeasible`: a `strongly_expected` record can
only sit beside a `necessary` one under a relation whose assertions admit exceptions at all.

### The external mappings

Read from `../../poi-taxonomy/data/taxonomy.json` at table version `0.4.0` (Overture schema `v1.17.0`):

```json
{
	"id": "pharmacy",
	"label": "Pharmacy",
	"hierarchy": ["health_and_medical", "pharmacy"],
	"basicLabel": "Pharmacy",
	"osmTag": "amenity=pharmacy",
	"source": "overture"
}
```

The category is authored in `curated-overlay.json` and emitted into `taxonomy.json`. It declares no
`overtureCategories`, so `resolveOvertureCategories("pharmacy")` is the identity `["pharmacy"]`. The mapping states
that the external identifier names this concept and nothing more: the containment hierarchy, the Overture-leaf
translation, the phrase lexicon and the brand table stay owned by `@mailwoman/poi-taxonomy`.
`test/unit/pharmacy-slice.test.ts` resolves the identifier through `getPOICategory` on every run, so a mapping onto a
category the taxonomy no longer carries fails there rather than translating into nothing.

The wave-1 sibling `poi-taxonomy-drugstore` reads the same way, onto `{ "id": "drugstore", "hierarchy": ["retail",
"drugstore"], "source": "overture" }` at the same table version. Its leaf is DISJOINT from
`health_and_medical > pharmacy`, which is the whole reason the second mapping reaches rows the first cannot: 7,168 rows
under `retail > drugstore` against 82,168 under the pharmacy leaf, 6,679 of them in the US, measured on `poi.db` at
manifest `2026-07-22.0`. Two mappings for one activity is not a preference — the schema has no field to state one
with, and the POI branch searches the union rather than choosing between them.

## `geographic-model.json` — the generated, committed artifact

Produced by `scripts/build-artifact.ts` from `model/`. **Do not hand-edit.** Regenerate with:

```bash
node packages/geographic-model/scripts/build-artifact.ts && npx oxfmt packages/geographic-model/data/geographic-model.json
```

The `oxfmt` pass is required because committed JSON must be `oxfmt`-clean (short arrays inline), which raw
`JSON.stringify` cannot reproduce. Both the compiler and `oxfmt` are deterministic, so the committed artifact is
reproducible from the records beside it.

`test/unit/pharmacy-slice.test.ts` holds it fresh, and compares PARSED values rather than bytes for exactly the reason
above — a byte comparison against `serializeCompiledModel` would fail on formatting the repository itself applies. Its
failure message names the command in the block above. Byte determinism is asserted where it is meaningful: between two
compiles of the same records, and between the committed artifact and a fresh compile once both have been run back
through `serializeCompiledModel`.

Nothing in the artifact records when it was built. `modelVersion` is the authored document's own `version`, so a
regenerate is a diff only when the records changed.
