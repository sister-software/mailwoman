# Migrating to v7.0.0 — the legacy rules-parser excision

v7.0.0 removes the legacy rule-based parser and its shared substrate. The neural sequence
labeler has been the primary parse path since v3; v7 deletes the dead rules engine that sat
behind it. If you use the `mailwoman` CLI or the high-level library API, **nothing changes** —
the neural pipeline is unaffected. The breaking changes below only touch consumers that imported
the low-level rule-classifier packages directly.

## 1. `@mailwoman/classifiers` is removed

The rule-classifier workspace (the `*Classifier` families, `adapter`, the composite scheme
machinery) is gone from the monorepo and deprecated on npm.

- **If you parse addresses:** use `mailwoman` (CLI) or `createRuntimePipeline` (library). This is
  the supported path and is unchanged.
- **If you depended on the rule classifiers directly:** pin `@mailwoman/classifiers@6.x`. That
  release works standalone (verified) and is frozen. There is no v7 equivalent — the capability
  moved into the neural model.
- `createAddressParser()` was already removed in v7's predecessor (the rules-parser deletion). The
  `mailwoman` umbrella no longer re-exports `@mailwoman/classifiers`.

## 2. `@mailwoman/core` no longer exports `./solver` or `./classification`

The v0 constraint solver (`@mailwoman/core/solver`) and the rule-classification machinery
(`@mailwoman/core/classification` — `BaseClassifier`, `CompositeClassifier`, `PhraseClassifier`,
`SectionClassifier`, `WordClassifier`, `scheme`) are deleted. They had no consumer outside the
removed rules parser.

Still exported and unchanged: `@mailwoman/core/tokenization` (`Graph`, `Span`, `TextNormalizer`),
`@mailwoman/core/types` (including the `Classification` string-set + the `ComponentTag` taxonomy
and its `mapping`), `@mailwoman/core/decoder`, and the rest of the core surface. The neural span
head decodes through `Span`/`Graph`, which stay in place.

The internal `core/tokenization` helpers `context`, `permutate`, and `split` were deleted with the
solver (they had no other consumer). If you imported `TokenContext`, it is gone with the rules
parser.

## 3. Deprecated `mailwoman` subpath shims removed

`mailwoman/sdk/cli` and `mailwoman/sdk/test` — deprecated since the CLI-kit/test-kit split — are
removed. Import from the real subpaths instead:

- `mailwoman/sdk/cli` → `mailwoman/cli-kit`
- `mailwoman/sdk/test` → `mailwoman/test-kit`

## 4. Acronym-casing renames (#875)

Whole-component acronym casing (`Us`→`US`, `Json`→`JSON`, `Jsonl`→`JSONL`) reaches the last public
identifiers. Rename table for the exported/breaking ones:

| Package                   | Before                         | After                          |
| ------------------------- | ------------------------------ | ------------------------------ |
| `@mailwoman/codex/us`     | `isUsStateAbbreviation`        | `isUSStateAbbreviation`        |
| `@mailwoman/codex/us`     | `UsStateAbbreviation`          | `USStateAbbreviation`          |
| `@mailwoman/codex/us`     | `UsUnitDesignator`             | `USUnitDesignator`             |
| `@mailwoman/codex/us`     | `UsPoBoxDesignator`            | `USPoBoxDesignator`            |
| `@mailwoman/codex/us`     | `UsStreetSuffix`               | `USStreetSuffix`               |
| `@mailwoman/codex/us`     | `UsMilitaryPostOfficeCode`     | `USMilitaryPostOfficeCode`     |
| `@mailwoman/codex/us`     | `UsArmedForcesRegionCode`      | `USArmedForcesRegionCode`      |
| `@mailwoman/codex/us`     | `UsMilitaryUnitDesignatorCode` | `USMilitaryUnitDesignatorCode` |
| `@mailwoman/codex/us`     | `UsMilitaryUnitMatch`          | `USMilitaryUnitMatch`          |
| `@mailwoman/codex/us`     | `UsMilitaryCityMatch`          | `USMilitaryCityMatch`          |
| `@mailwoman/codex/us`     | `UsFloorDesignator`            | `USFloorDesignator`            |
| `@mailwoman/codex/us`     | `UsFloorDesignatorName`        | `USFloorDesignatorName`        |
| `@mailwoman/core/utils`   | `pyJsonDumps`                  | `pyJSONDumps`                  |
| `@mailwoman/core/utils`   | `PyJsonOptions`                | `PyJSONOptions`                |
| `@mailwoman/corpus/tools` | `JsonlToParquetOptions`        | `JSONLToParquetOptions`        |
| `@mailwoman/corpus/tools` | `JsonlToParquetSummary`        | `JSONLToParquetSummary`        |

Unchanged on purpose: `JsonObject` (from `type-fest`), the `GeoJSON`/`toGeoJSON` family
(`@mailwoman/spatial`, already correctly cased), and `.json`/`.jsonl` file paths and `"us"` locale
codes (string contents, not identifiers).

## Summary

| You use…                                      | Action                                             |
| --------------------------------------------- | -------------------------------------------------- |
| `mailwoman` CLI / `createRuntimePipeline`     | none                                               |
| `@mailwoman/classifiers` directly             | pin `@6.x` (frozen)                                |
| `@mailwoman/core/solver` or `/classification` | none available — capability is in the neural model |
| `mailwoman/sdk/{cli,test}`                    | switch to `mailwoman/{cli-kit,test-kit}`           |
| the renamed public identifiers above          | apply the rename table                             |
