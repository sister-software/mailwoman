# `overture` adapter

Overture Maps **Addresses** theme → canonical corpus rows. The fill-rate-checked corpus adapter epic #470
(#471–477) always intended, realized 2026-06-20.

## Why

Overture's global Addresses theme is the single-schema, well-normalized address dataset that fixes
OpenAddresses' per-country patchiness: OA dropped Spain entirely and OA-DE omits the Bundesland, but
Overture publishes `{ street, number, unit, postcode, address_levels }` for **every** locale at scale
(FR 26M, IT 26M, DE 19M, ES 16M, NL 10M, …) — and it even re-hosts the OpenAddresses Spain data the
standalone OA bucket no longer serves. This adapter exists because the model was en-us/fr-trained and
never saw non-en/fr street formats (the 2026-06-19 EU parse-blocker measured locality-parse accuracy
ES 21% / IT 59% / NL 64% vs FR/US ~98%).

## Input

A per-country **line-delimited JSON** dump of the corpus-relevant fields:

```json
{ "street": "CALLE JULAN", "number": "12", "unit": null, "postcode": "38914", "locality": "El Pinar de El Hierro" }
```

The scripts-side ingest tool produces the dump and does the DuckDB / S3 work. The tool stays out of
`@mailwoman/corpus` because corpus is a **runtime dep of the `mailwoman` CLI** and mustn't pull the
heavy native `@duckdb/node-api`.

```sh
mailwoman gazetteer overture-ingest \
  --release 2026-06-17.0 --countries ES,IT,NL,PT --corpus-jsonl
# → $MAILWOMAN_DATA_ROOT/snapshots/overture/2026-06-17.0/addresses-<cc>.parquet
# → $MAILWOMAN_DATA_ROOT/corpus/staging/overture/2026-06-17.0/overture-<cc>.corpus.jsonl  (+ fill-rates.{json,md})
```

The Parquet copies are the release's snapshot and hold only what the ingest fetched. The corpus JSONL and the
fill-rate report are computed from them, so `overtureStagingPath(release)` in `paths.ts` places them beside the
other corpus adapter inputs under `corpus/staging/`.

## Run

`--country` is required because the JSONL is per-country and its rows omit a country field:

```sh
mailwoman corpus run overture \
  --input $MAILWOMAN_DATA_ROOT/corpus/staging/overture/2026-06-17.0/overture-es.corpus.jsonl \
  --country ES --output /data/corpus-staging
```

## Field map

| field      | ComponentTag                                                                                                  |
| ---------- | ------------------------------------------------------------------------------------------------------------- |
| `street`   | `street` — keyword included (`CALLE`/`VIA`/…); affix-relabel splits `street_prefix` downstream                |
| `number`   | `house_number` — skipped when `S-N` / `S/N` (sin número)                                                      |
| `unit`     | `unit` (if a designator), or joined into `house_number` where `OVERTURE_UNIT_FIELD_ROLES` specifies that role |
| `postcode` | `postcode`, in the groups the operator writes (`writtenPostcode`: `384 73`, `4524 JH`)                        |
| `locality` | `locality` — Overture `address_levels` municipality, or `postal_city`                                         |
| `region`   | `region` — the first `address_levels` value, only where `OVERTURE_REGION_FORMS` maps it                       |

The adapter renders every row through the country's codex layout, so a row takes the operator's order. It emits
no query-style order (postcode or town first).

Overture's `unit` field means different things per country. In Czechia it holds the orientation number, joined as
`320/28`. In Germany it holds a letter suffix, joined as `28a`. Elsewhere it is a secondary unit.

The region prints only where Overture's first level reads as the form the operator prints: the Brazilian UF
(`RS`), the Canadian province code (`QC`), and the Mexican state name mapped to the Correos de México
abbreviation (`Michoacán de Ocampo` → `MICH`). Elsewhere the first level is a unit the operator doesn't print
(Italy's `Sardegna`), so no region is rendered. A JSONL written before the ingest emitted `region` renders none.

## `overture-latam` and its address key

The BR, MX and CA runs stamp `overture-latam` (`corpus run overture --source-name overture-latam`), which training
configs weight apart from `overture`. `packages/corpus/data/builds/v0.8.23-rebuild/inputs.json` records the three runs
under `sourceRuns`, and `mailwoman corpus recorded-runs --inputs <that file>` runs them. A row's `source_id` hashes its
aligned components, so a run that adds the region or regroups the postcode gives each row a new id. The split
therefore also groups `overture-latam` rows by `overtureAddressKey` (`address-key.ts`), which leaves out the region
and the country and folds the postcode to its letters and digits. The frozen evaluation rows keep their groups
across the re-run through the keys the evaluation-group list records.

License: **CDLA-Permissive-2.0** (attribution required, without a share-alike term). Per the #471 fill-rate requirement, check
`fill-rates.md` before committing a locale. ES/NL/FR fill completely. IT postcode is ~0% (street+locality
only). DE postcode is sparse in Overture (use GeoNames for DE postcodes).
