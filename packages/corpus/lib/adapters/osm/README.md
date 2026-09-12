# `osm` adapter

OpenStreetMap addresses → canonical corpus rows, for the countries no permissive source covers (#733).
Overture's addresses theme has no rows for Pakistan, Bangladesh or Vietnam, and the Latin model has never
seen their formats.

## License — read this first

OpenStreetMap is **ODbL-1.0**, share-alike. Every row this adapter emits carries that license string, and
`SHARE_ALIKE_PATTERN` in `utils/license.ts` matches it. A proprietary-weights build passes
`--exclude-share-alike` and drops the rows at ingest; the open weights are the only ones that learn from
them. The adapter has no license option: the value is the contract.

## Input

A per-country line-delimited JSON file written by `@mailwoman/osm`'s `emit-corpus-jsonl` script from a
Geofabrik extract. GDAL and the PBF stay in that package; this one streams the result.

```bash
node packages/osm/out/scripts/emit-corpus-jsonl.js \
  --pbf $MAILWOMAN_DATA_ROOT/osm/geofabrik/pakistan-260819.osm.pbf \
  --out $MAILWOMAN_DATA_ROOT/osm/corpus/osm-pk.corpus.jsonl
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

`--country` is required (the JSONL is per-country; rows omit a country field):

```bash
mailwoman corpus run osm \
  --input $MAILWOMAN_DATA_ROOT/osm/corpus/osm-vn.corpus.jsonl \
  --country VN --output /data/corpus-staging
```

## Mapping

| field                                                               | ComponentTag                                                          |
| ------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `number`                                                            | `house_number`, when designator-shaped (`12`, `14/E`, `188a`, `B-77`) |
| `street`                                                            | `street`, when a name (no comma, at most eight words)                 |
| `unit`                                                              | `unit`                                                                |
| `postcode`                                                          | `postcode`, when four to six digits                                   |
| `city` (the part after the last comma)                              | `locality`                                                            |
| `suburb` ?? `subdistrict` ?? `district` ?? `place` ?? the city head | `dependent_locality`                                                  |
| `province`                                                          | `region`, unless it repeats the locality                              |

Mappers write whole lines into `addr:housenumber` (`House 34, Road 4, Sector 9`) and `addr:street`; those
rows keep the street and lose the number, or are skipped. `addr:city` in Bangladesh often carries the
neighborhood ahead of the city (`Mirpur 10, Dhaka`), so the tail is the locality and the head the dependent
locality. `addr:district` is not mapped beside a city: Vietnam's template renders it only when no city is
present, and a component with no span to align to quarantines the row.

The rendered line follows the country template (`24 Road 104, Dhaka - 1207`; `359 Đường Nguyễn Văn Cừ,
Thành phố Bắc Ninh, Bắc Ninh`). The typed registers the templates do not produce, Islamabad's `House 4,
Street 25, F-7/2` and Dhaka's `Dhaka 1205` without the dash, are recipes over the same JSONL.
