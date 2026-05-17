# `openaddresses` adapter

OpenAddresses (<https://openaddresses.io>) aggregates open-data address
dumps from hundreds of city, county, and state sources worldwide. The
adapter consumes the **line-delimited GeoJSON** (`.geojsonl` /
`.ndgeojson`) shape one Feature per line, which streams cleanly for the
multi-gigabyte national dumps.

## Input

Download a country-partitioned dump from:
<https://batch.openaddresses.io/data> (the `collection.geojsonl` files
under `us/`, `ca/`, `fr/`, etc.).

Point `--input` at a single `.geojsonl` (or `.geojson` if your dump
ships as line-delimited despite the extension). The runner is invoked
with `--country US|CA|FR|...` to stamp the country on every row —
OpenAddresses Features themselves do not carry a country code, so this
flag is required.

```sh
npx mailwoman corpus run openaddresses \
  --input /data/oa/us-northeast.geojsonl \
  --country US \
  --output /data/corpus/sources/
```

## Per-row license

OpenAddresses aggregates sources with **different licenses** (CC-BY,
CC0, PDDL, ODbL, sometimes proprietary attribution-only). The adapter
preserves each Feature's `LICENSE` property verbatim onto the emitted
row's `license` field. If a Feature has no `LICENSE` property, the
adapter falls back to:

1. The `defaultLicense` passed to `createOpenaddressesAdapter()` (if the
   operator overrode it for a known single-license dump), or
2. `CC-BY-4.0` — the most common across the OA collection.

Downstream training code can stratify or exclude by license via the
`license` field on every row.

## Properties consumed

| OA property             | Mailwoman component                            |
| ----------------------- | ---------------------------------------------- |
| `number` / `NUMBER`     | `house_number`                                 |
| `street` / `STREET`     | `street`                                       |
| `unit` / `UNIT`         | `unit` (if non-empty)                          |
| `city` / `CITY`         | `locality`                                     |
| `region` / `REGION`     | `region` (state / province / subdivision)      |
| `postcode` / `POSTCODE` | `postcode`                                     |
| `hash`, `id`            | `source_id` seed (`hash` preferred)            |
| `LICENSE` / `license`   | per-row `license` (overrides `defaultLicense`) |

`district` is **not** mapped — for US data it carries borough or
county, which is not part of postal addresses and would inflate the
alignment quarantine pile. A future Phase 6+ adapter for non-US locales
(where district names do appear on the envelope) can revisit.

## Output

One `CanonicalRow` per usable Feature:

- `raw`: rendered via `formatAddress(components, country, { separator: ", " })`
  so each country gets its idiomatic line.
- `components`: `{ house_number?, street, unit?, locality?, region?, postcode? }`
- `country`: passed through from `--country`.
- `license`: per-row (see above).
- `source_id`: `openaddresses-<hash>` if `hash` is present, else
  `openaddresses-<id>` if `id` is present, else a content-addressed
  fallback via `stableSourceId`.

## Known quirks

- Real OA dumps store `street` and `city` in UPPERCASE (legacy USPS
  convention). The adapter preserves case verbatim; synthesis (`synthesize.ts`)
  handles case-perturbation as its own augmentation.
- Feature lines that fail to parse, are blank, are comments (`#…`), or
  carry a non-`Feature` `type` (e.g. a stray `FeatureCollection`) are
  skipped silently. Counted neither yielded nor written.
- Features without `street` or without both `city` and `postcode` are
  dropped at the source — they'd be quarantined downstream anyway.

## Fixture

`fixtures/openaddresses/sample-us.geojson` — 6 hand-crafted Features
covering NY, OR, CA, WA, TX with a mix of per-row licenses (CC-BY-4.0,
PDDL-1.0, CC0-1.0, CC-BY-SA-4.0) plus one row with no `LICENSE`
property to exercise the default-fallback path.
