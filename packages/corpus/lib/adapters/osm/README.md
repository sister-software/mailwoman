# `osm` adapter

OpenStreetMap addresses → canonical corpus rows, for the countries no permissive source covers (#733).
Overture's addresses theme has no rows for Pakistan, Bangladesh or Vietnam, and the Latin model has never
seen their formats.

## License — read this first

OpenStreetMap is **ODbL-1.0**, share-alike. Every row this adapter emits stores that license string, and
`@mailwoman/core/license/obligations` records share-alike among ODbL's obligations. A proprietary-weights
build runs `mailwoman corpus build --license-policy share-alike-free`, which refuses these rows at ingest,
so the open weights are the only ones that learn from them. The adapter has no license option: the value
is the interface.

The OpenStreetMap Foundation's Attribution Guidelines include machine-learning guidance. For Mailwoman,
model documentation generated from an effective training manifest states the required OSM attribution
when OSM-derived rows reached the trainer for a checkpoint. `requiredAttributions` in
`#source-register/effective-manifest` derives that from the sources that reached the trainer, and its
statement is `OSM_ATTRIBUTION` in this adapter. A corpus that holds OSM rows the run never drew owes no
attribution for them. The statement covers OSM only. Another ODbL licensor's terms are read from its
own register entry.

`--license-policy` reads each row's license value through `readLicenseRecord` and refuses it under one of
three classes. `utils/license.ts` documents those classes. The reader replaced an anchored prefix match over
the license column. That match admitted a row whose license was prose mentioning ODbL rather than the identifier.

## Input

A per-country line-delimited JSON file written by `@mailwoman/osm`'s `emit-corpus-jsonl` script from a
Geofabrik extract. GDAL and the PBF stay in that package, and this one streams the result.

```bash
node packages/osm/out/tools/emit-corpus-jsonl.js \
  --pbf $MAILWOMAN_DATA_ROOT/db/osm/geofabrik/pakistan-260819.osm.pbf \
  --out $MAILWOMAN_DATA_ROOT/db/osm/corpus/osm-pk.corpus.jsonl
```

```json
{
	"street": "Đường Nguyễn Văn Cừ",
	"number": "359",
	"city": "Bắc Ninh",
	"district": "Thành phố Bắc Ninh",
	"lat": 21.1699887,
	"lon": 106.0492095
}
```

## Run

`--country` is required because the JSONL is per-country and its rows omit a country field:

```bash
mailwoman corpus run osm \
  --input $MAILWOMAN_DATA_ROOT/db/osm/corpus/osm-vn.corpus.jsonl \
  --country VN --output /data/corpus-staging
```

## Field map

| field                                                                                                | ComponentTag                                                          |
| ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `number`                                                                                             | `house_number`, when designator-shaped (`12`, `14/E`, `188a`, `B-77`) |
| `street`                                                                                             | `street`, when a name (no comma, at most eight words)                 |
| `unit`                                                                                               | `unit`                                                                |
| `postcode`                                                                                           | `postcode`, when it has the country's format (`matchCountryPostcode`) |
| `city` (the part after the last comma) ?? `boundary_locality`                                        | `locality`                                                            |
| `suburb` ?? `subdistrict` ?? `district` ?? `place` ?? the city head ?? `boundary_dependent_locality` | `dependent_locality`                                                  |
| `province`                                                                                           | `region`, unless it repeats the locality                              |

`boundary_locality` and `boundary_dependent_locality` are present only when `emit-corpus-jsonl` ran with
`--locality-level` or `--dependent-locality-level`: the name of the `boundary=administrative` area at that
level which contains the point, written only where the mapper tagged no `addr:city` (or `addr:suburb`).
A tagged value always wins, and a row that took its locality from a boundary counts
`kept:locality-from-boundary`. Serbia's settlements are level 9 and its city quarters level 10; Brunei's
municipality is level 7, its mukims level 6 and its kampongs levels 10 and 8.

A record with no `addr:street` is a streetless premise when its house number is designator-shaped and
an `addr:place` or `addr:city` is present: `12, Ивановка, Тула` keeps `house_number`,
`dependent_locality` and `locality`. That is OSM's scheme for numbering within a place that has no streets, and it is
the shape the `streetless-premise-identity` phenomenon counts. A record whose `addr:street` holds a line
rather than a name stays refused.

Every refused record and every discarded component increments a reason in the run's `MANIFEST.json`
`dropped` map (`row:street-not-a-name`, `component:house_number:not-designator`, …). The extract's own
counts, per GDAL layer, sit in the `<jsonl>.stats.json` sidecar `emit-corpus-jsonl` writes, beside the
`<pbf>.receipt.json` that `tools/fetch/extract.ts` writes for the PBF.

Mappers write whole lines into `addr:housenumber` (`House 34, Road 4, Sector 9`) and `addr:street`; those
rows keep the street and lose the number, or are skipped. A comma in `addr:city` is the neighborhood ahead of the
city (`Mirpur 10, Dhaka` in Bangladesh): the tail is the locality, and the head enters the
`dependent_locality` chain last, behind `suburb`, `subdistrict`, `district` and `place`. A value with no
comma is only the locality. `addr:district` is not mapped beside a city: Vietnam's template renders it only when no city is
present, and a component with no span to align to quarantines the row.

The rendered line follows the country template (`24 Road 104, Dhaka - 1207`; `359 Đường Nguyễn Văn Cừ,
Thành phố Bắc Ninh, Bắc Ninh`). The typed registers the templates do not produce, Islamabad's `House 4,
Street 25, F-7/2` and Dhaka's `Dhaka 1205` without the dash, are recipes over the same JSONL.
