# `geonames` adapter

GeoNames populated-places → `CanonicalRow`. Global locality coverage (incl. the small towns a
coarser admin gazetteer lacks) — the cheapest way to broaden the corpus's **locale** coverage.

- **Source:** [GeoNames](https://www.geonames.org/) geographical database.
- **License:** **CC-BY-4.0** (attribution required on redistribution). Stamped `"CC-BY-4.0"` per row;
  attribute "GeoNames" in any redistributed corpus. See `feedback-no-load-bearing-trivia` — the
  per-row `license` + `source`/`source_id` are the provenance record.
- **Coverage:** every country GeoNames publishes; this adapter ingests `feature_class = "P"`
  (populated places), excluding historical/abandoned/destroyed codes (`PPLH`/`PPLQ`/`PPLW`/`PPLCH`).

## Download

Per-country dumps + two sibling name files, all from the same directory:

```bash
DIR=/mnt/playpen/mailwoman-data/geonames
mkdir -p "$DIR" && cd "$DIR"
curl -O https://download.geonames.org/export/dump/US.zip && unzip -o US.zip   # → US.txt (per country)
curl -O https://download.geonames.org/export/dump/admin1CodesASCII.txt        # <CC>.<admin1> → region name
curl -O https://download.geonames.org/export/dump/countryInfo.txt             # ISO → country name
```

The `admin1CodesASCII.txt` and `countryInfo.txt` must sit in the **same directory** as the country
file; the adapter reads them as siblings of `inputPath`. If either is missing the corresponding
component (region / country) is omitted and the adapter still emits locality-only rows.

## Run

```bash
# Single country (CLI):
npx mailwoman corpus run geonames --input /mnt/playpen/mailwoman-data/geonames/US.txt --country US --limit 5000

# In a full build, configure adapterInputs["geonames"] = { inputPath: ".../<CC>.txt", country: "<CC>" }
# per country you want ingested. `corpus build` skips the adapter when no input is configured.
```

## Output

Up to two hierarchy variants per place (domestic + international order, mirroring `wof-admin`):

| variant | components | raw |
| --- | --- | --- |
| `lr` | `{ locality, region }` | `Montpelier, Vermont` |
| `lrc` | `{ locality, region, country }` | `Montpelier, Vermont, United States` |

`source_id` = `geonames-<geonameid>-<variant>`. When region/country names are unavailable the adapter
falls back to `{ locality, country }` or `{ locality }`.

## Format reference

GeoNames main-table columns (0-based, tab-separated, no header) used here:
`0` geonameid · `1` name · `3` alternatenames · `6` feature_class · `7` feature_code ·
`8` country_code · `10` admin1_code. Full schema: the "geoname" table in the
[export readme](https://download.geonames.org/export/dump/readme.txt).
