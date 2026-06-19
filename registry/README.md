# @mailwoman/registry

**Geocode-first record-matching application** — the high-level entry point that
runs the full block → score → cluster pipeline over ingested records and returns
canonical entities ready for export.

This is the clinic-funding use case Mailwoman was built for, standing on a
calibrated, label-free matcher.

```ts
import { resolveEntities, ingestRows, toGeoJSON } from "@mailwoman/registry";

// 1. Ingest — CSV/array → normalized SourceRecords
const records = ingestRows(rows, {
  mapping: { name: "Provider Name", address: "Street Address", city: "City", ... },
});

// 2. Resolve — block → score → cluster with geo-first defaults
const entities = resolveEntities(records, {
  geocodeAddress: async (row) => ({ lat: 30.2672, lon: -97.7431 }),
});

// 3. Export — GeoJSON for QGIS
const fc = toGeoJSON(entities);
// → FeatureCollection with Point features + entity properties
```

## The full pipeline

```
CSV / SQLite → ingestRows → SourceRecord[] → resolveEntities → ResolvedEntity[]
                                                                    ↓
                                                               toGeoJSON()
                                                                    ↓
                                                            GeoJSON → QGIS
```

## API

```ts
// Ingest — parse CSV / map columns → normalized records
import { ingestRows, parseCsv, inferMapping } from "@mailwoman/registry";
// {
//   ingestRows(rows, opts): SourceRecord[]
//   parseCsv(csvText): string[][]
//   inferMapping(headers): ColumnMapping
// }

// Resolve — run the full matcher pipeline
import { resolveEntities } from "@mailwoman/registry";
// resolveEntities(records, config): ResolvedEntity[]
// Config: { geocodeAddress?, scorer?, blockingKeys?, threshold?, discriminators? }

// Export — GeoJSON, MapLibre HTML, reconciliation reports
import { toGeoJSON, toMapHTML, reconcile } from "@mailwoman/registry";

// Learned scorer — pre-trained GBT for single-dataset dedup
import { dedupGbtEnUs } from "@mailwoman/registry";
```

## Default configuration

`resolveEntities` ships with sensible defaults:

- **Blocking keys:** geo-cell (H3) + canonical address + phone + email
- **Scoring model:** Fellegi-Sunter with label-free EM, term frequency adjustment
- **Learned scorer:** optional GBT for single-dataset dedup (opt-in via `scorer`)
- **Threshold:** 0.5 (configurable precision/recall knob)

## CLI

The `mailwoman` CLI exposes `registry` as a command:

```bash
# Multi-source entity resolution
mailwoman registry --sources config.json --out entities.geojson

# Cross-dataset reconciliation
mailwoman registry --sources tx-nppes.json --reconcile tx-fcc.json
```

## Related

- [`@mailwoman/match`](../match) — the low-level block/score/cluster primitives
- [`@mailwoman/record`](../record) — `SourceRecord` schema and normalizers
- [`@mailwoman/address-id`](../address-id) — exact-match join key
- [Geocode-First Record Matching](https://mailwoman.sister.software/articles/concepts/geocode-first-record-matching/)
- [Dedup Entity Truth](https://mailwoman.sister.software/articles/concepts/dedup-entity-truth/)

## License

[AGPL-3.0-only](https://www.gnu.org/licenses/agpl-3.0.html)
