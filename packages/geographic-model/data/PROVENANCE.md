# `data/` provenance

## `model/` — the authored records

The authoring source for the frozen pharmacy slice. Six concepts, one relation, one external mapping, one assertion.
Authored by hand; edit these and regenerate the artifact below.

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

| File             | Record                                                                                       | Reading                                                                                                        |
| ---------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `relations.json` | `affords`                                                                                    | `establishment` → `activity`, not transitive, not symmetric, `hard` semantics — an exception is a defect       |
| `concepts.json`  | `place`, `establishment`, `healthcare_facility`, `pharmacy`, `activity`, `obtain_medication` | the `isA` chain the slice names, and one assertion: `pharmacy affords obtain_medication`, modality `necessary` |
| `mappings.json`  | `poi-taxonomy-pharmacy`                                                                      | `@mailwoman/poi-taxonomy` category `pharmacy` names the `pharmacy` concept                                     |

Identifiers are bare (`pharmacy`, not `mw:pharmacy`). The issue writes the `mw:` prefix as namespace notation in prose;
a literal colon inside a concept identifier would collide with the separator `compileGeographicModel` builds derived
identifiers from, which is a collision its `duplicate_derived_fact_id` refusal exists to catch.

`modality: "necessary"` pairs with the relation's `hard` semantics: dispensing medication to the public is what makes
premises a pharmacy, so a counter-example falsifies the record instead of qualifying it. No `countries` scope is
authored — the country-conditional part of the question is which OTHER establishment classes afford the activity, and
the slice authors no second class.

### The external mapping

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
