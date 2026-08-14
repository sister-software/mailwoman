# @mailwoman/registry

**Geocode-first record-matching application** — the high-level entry point that
runs the full block → score → cluster pipeline over ingested records and returns
canonical entities ready for export.

This is the clinic-funding use case Mailwoman was built for, standing on a
calibrated, label-free matcher.

```ts
import { ingestRows, resolveEntities, toGeoJSON } from "@mailwoman/registry"

// 1. Ingest — rows → normalized SourceRecords. The mapping is POSITIONAL (arg 2), not a field of the
//    options object, and `geocodeAddress` belongs here: each address is resolved as it is ingested.
const records = await ingestRows(
	rows,
	{ organization: "Provider Name", address: ["Street Address", "City", "State", "ZIP"] },
	{ geocodeAddress }
)

// 2. Resolve — block → score → cluster with geo-first defaults. SYNCHRONOUS, and it returns a
//    ResolveResult, not a bare array: `entities` alongside the pair counts blocking produced.
const { entities, candidatePairs, droppedBlocks } = resolveEntities(records)

// 3. Export — GeoJSON for QGIS. Entities with no resolved coordinate are skipped, so the feature
//    count can be lower than `entities.length`.
const fc = toGeoJSON(entities)
```

## The full pipeline

```
CSV / SQLite → ingestRows → SourceRecord[] → resolveEntities → ResolveResult
                                                                    ↓
                                                            .entities → toGeoJSON()
                                                                    ↓
                                                            GeoJSON → QGIS
```

## API

```ts
// Ingest — parse CSV / map columns → normalized records
import { inferMapping, ingestRows, normalizeCSV, parseCSV } from "@mailwoman/registry"
// ingestRows(rows, mapping, opts?): Promise<SourceRecord[]>
//   opts: { geocodeAddress?, addressSeparator? }  — addressSeparator defaults to ", "
// parseCSV(text): Record<string, string>[]
// inferMapping(header): ColumnMapping
// normalizeCSV(path, { mapping, delimiter? }): AsyncGenerator<SourceRecord>  — streams, does NOT geocode

// Resolve — run the full matcher pipeline
import { resolveEntities } from "@mailwoman/registry"
// resolveEntities(records, config?): ResolveResult
//   ResolveResult: { entities, candidatePairs, droppedBlocks }
//   config: { model?, blockingKeys?, threshold?, maxBlockSize?, trainEM?, addressFrequency?,
//             collapseSpatial?, requireCorroboration?, usePhone?, linkage?, discriminators?,
//             exactDiscriminators?, scorer?, learnedScorer? }

// Export — GeoJSON, MapLibre HTML, reconciliation reports
import { reconcile, toGeoJSON, toMapHTML } from "@mailwoman/registry"

// Learned scorer — pre-trained GBT for single-dataset dedup, default-on
import { DEDUP_GBT_META, DEDUP_GBT_MODEL } from "@mailwoman/registry"
```

`geocodeAddress` is an `ingestRows` option, not a `resolveEntities` one — coordinates have to exist
before blocking can use them.

## Default configuration

`resolveEntities` ships with these defaults:

- **Blocking keys:** geo-cell on the resolved coordinate (0.05°, neighbours expanded) + canonical
  address + phone + email
- **Scoring model:** Fellegi-Sunter with label-free EM, term frequency adjustment
- **Learned scorer:** the bundled `DEDUP_GBT_MODEL`, on by default for single-dataset dedup
- **Threshold:** `DEDUP_GBT_META.recommendedThreshold` (2.8324) while the bundled model is active,
  otherwise 0. The unit is the GBT's own logit, not a Fellegi-Sunter match weight in bits and not a
  probability, so a 0-to-1 value is a category error here. Higher is stricter.
- **Linkage:** single (connected components), with average linkage available for the over-merge case

## CLI

The `mailwoman` CLI exposes `registry` as a command:

```bash
# Multi-source entity resolution
mailwoman registry --sources config.json --resolve-db "$MAILWOMAN_CANDIDATE_DB" --out entities.geojson

# Cross-dataset reconciliation
mailwoman registry --sources tx-nppes.json --reconcile tx-fcc.json --resolve-db "$MAILWOMAN_CANDIDATE_DB"
```

`--resolve-db` (or `$MAILWOMAN_WOF_DB`) is required to BOOT, and is then ignored whenever
`$MAILWOMAN_CANDIDATE_DB` is set. `resolveWOFPath` throws before anything opens; `createResolverBackend`
then prefers the candidate backend and never touches the WOF path (`run.tsx`'s own inline comment states
this correctly: "`$MAILWOMAN_CANDIDATE_DB` → the demo-parity candidate backend; else FTS over wofPath").
A nonexistent path passes the gate.

So: set `$MAILWOMAN_CANDIDATE_DB` and pass anything to `--resolve-db`. Do NOT pass `candidate.db` to
`--resolve-db` with the environment variable unset — the flag is believed on that path, and the admin
backend queries `place_search`/`spr`, which a candidate gazetteer does not have.

Requiring an argument in order to discard it is a defect in this command. Documented rather than fixed.

Two CLI defaults differ from the library defaults: `--threshold` defaults to `0`, which is the
Fellegi-Sunter baseline rather than the bundled model's calibrated 2.8324, and `--train-em` is on.

## Related

- [`@mailwoman/match`](../match) — the low-level block/score/cluster primitives
- [`@mailwoman/record`](../record) — `SourceRecord` schema and normalizers
- [`@mailwoman/address-id`](../address-id) — exact-match join key
- [Match messy records to one entity each](https://mailwoman.sister.software/docs/developers/how-to/match-messy-records)

## License

[AGPL-3.0-only](https://www.gnu.org/licenses/agpl-3.0.html)
