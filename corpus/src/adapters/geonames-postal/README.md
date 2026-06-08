# `geonames-postal` adapter

GeoNames postal-code dump → `CanonicalRow`. Multi-locale **postcode → locality → region** with
place + region names **inline** (no aux-file join), covering ~80 countries — broadens postcode
coverage well beyond `wof-postalcode`/the coordinate-first table (forward coverage for the
multi-locale goal).

- **Source:** [GeoNames postal export](https://download.geonames.org/export/zip/).
- **License:** **CC-BY-4.0** (attribute "GeoNames"); stamped per row.

## Download

```bash
DIR=/mnt/playpen/mailwoman-data/geonames-postal
mkdir -p "$DIR" && cd "$DIR"
for cc in DE FR ES IT NL; do curl -O "https://download.geonames.org/export/zip/$cc.zip" && unzip -o "$cc.zip"; done
```

## Run

```bash
npx mailwoman corpus run geonames-postal --input /mnt/playpen/mailwoman-data/geonames-postal/DE.txt --country DE --limit 50000
```

**Prefer non-US countries.** This adapter emits postcode-FIRST (international) order — correct for
DE/FR/most of the world. US postcodes are postcode-LAST and are already covered by TIGER/WOF; don't
ingest US through this adapter.

## Output

Per row, up to two postcode-first variants:

| variant | components                       | raw                          |
| ------- | -------------------------------- | ---------------------------- |
| `pl`    | `{ postcode, locality }`         | `75001 Paris`                |
| `plr`   | `{ postcode, locality, region }` | `75001 Paris, Île-de-France` |

The region variant is skipped when admin1 just repeats the place (city-states / micro-admin), to
avoid `"X X"` noise. `source_id` = component-hash + variant.

## Format reference

12 tab-separated columns, no header: `country, postcode, place, admin1_name, admin1_code,
admin2_name, admin2_code, admin3_name, admin3_code, latitude, longitude, accuracy`. This adapter reads
`country, postcode, place, admin1_name`. Full layout: the [export readme](https://download.geonames.org/export/zip/readme.txt).
