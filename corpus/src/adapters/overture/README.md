# `overture` adapter

Overture Maps **Addresses** theme → canonical corpus rows. The gated corpus adapter epic #470
(#471–477) always intended, realized 2026-06-20.

## Why

Overture's global Addresses theme is the single-schema, well-normalized address dataset that fixes
OpenAddresses' per-country patchiness: OA dropped Spain entirely and OA-DE omits the Bundesland, but
Overture carries `{ street, number, unit, postcode, address_levels }` for **every** locale at scale
(FR 26M, IT 26M, DE 19M, ES 16M, NL 10M, …) — and it even re-hosts the OpenAddresses Spain data the
standalone OA bucket no longer serves. This adapter exists because the model was en-us/fr-trained and
never saw non-en/fr street formats (the 2026-06-19 EU parse-blocker measured locality-parse accuracy
ES 21% / IT 59% / NL 64% vs FR/US ~98%).

## Input

A per-country **line-delimited JSON** dump of the corpus-relevant fields:

```json
{ "street": "CALLE JULAN", "number": "12", "unit": null, "postcode": "38914", "locality": "El Pinar de El Hierro" }
```

Produced by the scripts-side ingest tool (which does the DuckDB / S3 heavy lifting — it stays out of
`@mailwoman/corpus` because corpus is a **runtime dep of the `mailwoman` CLI** and must not pull the
heavy native `@duckdb/node-api`):

```bash
node --experimental-strip-types scripts/ingest-overture-addresses.ts \
  --release 2026-06-17.0 --countries ES,IT,NL,PT --corpus-jsonl
# → /mnt/playpen/mailwoman-data/overture/2026-06-17.0/overture-<cc>.corpus.jsonl  (+ addresses-<cc>.parquet + fill-rates.{json,md})
```

## Run

`--country` is REQUIRED (the JSONL is per-country; rows omit a country field):

```bash
mailwoman corpus run overture \
  --input /mnt/playpen/mailwoman-data/overture/2026-06-17.0/overture-es.corpus.jsonl \
  --country ES --output /data/corpus-staging
```

## Mapping

| field      | ComponentTag                                                                                   |
| ---------- | ---------------------------------------------------------------------------------------------- |
| `street`   | `street` — keyword included (`CALLE`/`VIA`/…); affix-relabel splits `street_prefix` downstream |
| `number`   | `house_number` — skipped when `S-N` / `S/N` (sin número)                                       |
| `unit`     | `unit` (if non-empty)                                                                          |
| `postcode` | `postcode`                                                                                     |
| `locality` | `locality` — Overture `address_levels` municipality, or `postal_city`                          |

Overture's admin levels stop at the municipality, which is all this street/locality shard needs. The
few in-text-region locales (DE Bundesland, FR département) are covered by the `geonames-postal` adapter
(it already emits `{ postcode, locality, region }`) — don't duplicate that here.

License: **CDLA-Permissive-2.0** (attribution; not share-alike). Per the #471 fill-rate gate, check
`fill-rates.md` before committing a locale: ES/NL/FR fill cleanly; IT postcode is ~0% (street+locality
only); DE postcode is sparse in Overture (use GeoNames for DE postcodes).
