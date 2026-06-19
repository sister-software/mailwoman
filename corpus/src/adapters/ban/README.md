# `ban` adapter

Base Adresse Nationale (FR), the authoritative French house-number-level
address dump from `adresse.data.gouv.fr`. ~25M rows nationally; the highest-
quality French source available.

## Input

Download the per-département CSV files or the national dump from:
<https://adresse.data.gouv.fr/data/ban/adresses/latest/csv/>

Files are semicolon-separated. The adapter streams via `csv-parse`, so
the national 25M-row dump never sits in memory.

Point `--input` at the `.csv` file directly. Decompress first if you
downloaded the `.csv.gz` variant.

## Columns consumed

| BAN column    | ComponentTag                                    |
| ------------- | ----------------------------------------------- |
| `numero`      | `house_number` (with `rep`)                     |
| `rep`         | appended to `house_number` (bis / ter / quater) |
| `nom_voie`    | `street` (includes "Rue", "Avenue", etc.)       |
| `code_postal` | `postcode`                                      |
| `nom_commune` | `locality`                                      |

Everything else (`id_fantoir`, `x`, `y`, `lon`, `lat`, `type_position`,
`source`, `certification_commune`) is ignored — Phase 1 is component-
level only; spatial fields belong in a future Phase 5+ adapter.

## Output

One `CanonicalRow` per BAN record:

- `raw`: `"10 bis Avenue des Champs-Élysées, 75008 Paris"`
- `components`: `{ house_number, street, postcode, locality }`
- `country`: `"FR"`
- `locale`: `"fr-FR"`
- `license`: `"Licence Ouverte 2.0"` — BAN is dual-licensed (Licence Ouverte 2.0 OR ODbL); we elect Licence Ouverte (#26 Tier B, allowed for training with attribution). Model card must attribute BAN.
- `source_id`: `"ban-<csv-id>"` (BAN's native `id` column is stable)

`region` is **not** populated — BAN doesn't carry it. The wof-admin /
wof-postalcode adapters supply region/country at corpus build time via
postcode cross-reference. The training split key looks at `region` so
BAN-only rows will land in the default `train` split unless joined with a
WOF row that fills in the region. (Documented limitation; future work can
add a region-lookup table by postcode prefix.)

## Known quirks

- BAN's `code_insee` and `code_insee_ancienne_commune` track historical
  commune mergers. The adapter ignores both — only the current `nom_commune`
  appears in the corpus.
- Some rows have `numero=0` (placeholder for "no number"). The adapter
  drops these unless a postcode is present.
- BAN periodically re-issues `id` values; consumers that pin to a specific
  BAN snapshot should record the dump's date alongside the corpus version.

## Fixture

`fixtures/ban/sample.csv` — 7 hand-crafted rows covering Paris, Lyon,
Marseille, Nice. Includes a `bis` row (Champs-Élysées #1bis) to exercise
the `rep` composition. Real BAN columns; ODbL-clean (synthetic values).
