# `ban` adapter

The Base Adresse Nationale, IGN's house-number-level address publication, from
`adresse.data.gouv.fr`. It covers eleven jurisdictions from one schema: France and the
ten overseas jurisdictions whose files carry rows.

Measured on 2026-10-01, by parsing each published file whole:

| jurisdiction              | INSEE department | rows       |
| ------------------------- | ---------------- | ---------- |
| France                    | `01`–`95`        | 26,117,350 |
| Réunion                   | `974`            | 340,941    |
| Guadeloupe                | `971`            | 163,423    |
| Martinique                | `972`            | 138,460    |
| French Guiana             | `973`            | 60,904     |
| Mayotte                   | `976`            | 52,588     |
| New Caledonia             | `988`            | 51,702     |
| French Polynesia          | `987`            | 7,713      |
| Saint Martin              | `978`            | 7,363      |
| Saint Barthélemy          | `977`            | 5,553      |
| Saint Pierre and Miquelon | `975`            | 3,049      |

`984` French Southern Territories and `986` Wallis and Futuna are published as 20-byte files
with no header line, which is a measured zero rather than a missing path. Both map to `TF` and
`WF` anyway, so a row appearing under either is labeled rather than read as metropolitan.
`989` Clipperton has no ISO 3166-1 alpha-2 code, so a row there has nowhere correct to go.

## Input

Download a per-department CSV or the whole-country extract from
<https://adresse.data.gouv.fr/data/ban/adresses/latest/csv/>, which lists 107 department files.

Files are semicolon-separated and double-quote no field. The adapter streams via
`CSVSpliterator`, so the 26M-row extract never sits in memory.

Point `--input` at the `.csv` file directly. Decompress first if you downloaded the `.csv.gz`
variant. **The file is republished daily**, so record its date and digest beside a row count
taken from it.

## Columns consumed

| BAN column    | use                                                |
| ------------- | -------------------------------------------------- |
| `numero`      | `house_number`, with `rep` appended                |
| `rep`         | the repetition index: `bis`, `ter`, `quater`       |
| `nom_voie`    | split into `street_prefix` and `street`            |
| `code_postal` | `postcode`                                         |
| `code_insee`  | the row's country, read from the department prefix |
| `nom_commune` | `locality`                                         |
| `id`          | `source_id`, as `ban-<id>`                         |

The other sixteen columns of the 23 the header declares are read by no part of this adapter:
`id_fantoir`, `code_insee_ancienne_commune`, `nom_ancienne_commune`, `x`, `y`, `lon`, `lat`,
`type_position`, `alias`, `nom_ld`, `libelle_acheminement`, `nom_afnor`, `source_position`,
`source_nom_voie`, `certification_commune` and `cad_parcelles`. The spatial fields belong to a
later adapter that carries geometry.

## Output

One `CanonicalRow` per BAN record:

- `raw`: `"1 bis Avenue des Champs-Élysées, 75008 Paris"`
- `components`: `{ house_number, street_prefix, street, postcode, locality }`
- `country`: read per row from `code_insee`, so one extract spanning departments yields each
  jurisdiction's own code
- `locale`: `fr-<country>`, because every jurisdiction BAN publishes writes its addresses in
  French and the region carries the jurisdiction
- `license`: `"Licence Ouverte 2.0"`. BAN is dual-licensed under Licence Ouverte 2.0 or ODbL and
  this adapter elects Licence Ouverte, whose terms permit training with attribution. The model
  card must attribute BAN.
- `source_id`: `"ban-<csv-id>"`, since BAN's own `id` column is stable
- `source`: `ban`. This is a wire identifier: it is the literal `source` value on every row of
  every corpus built from it, and `ban: 3.0` and similar appear as `source_weights` keys across
  the training configs. Renaming it is a data migration rather than an edit.

`--country` is optional. Passing one both rejects a jurisdiction BAN does not publish and keeps
only that jurisdiction's rows, so one multi-department extract can be read once per country.

`region` is **not** populated — BAN carries no region column. The wof-admin and wof-postalcode
adapters supply it at corpus build time through a postcode cross-reference. The training split key
reads `region`, so a BAN-only row lands in the default `train` split unless it joins a WOF row
that fills the region in.

## Known quirks

- A row can carry a house number and a position with no street name. The adapter's street check
  drops those. French Polynesia is where this bites: `nom_voie` is empty on 958 of its 7,713 rows,
  which is 12.4%, and every one of them is in `98736` Pirae with `source_nom_voie` reading
  `commune`. Every other jurisdiction reads 100%.
- `code_insee` and `code_insee_ancienne_commune` track historical commune mergers. The adapter
  reads `code_insee` for the country only, and the corpus carries the current `nom_commune`.
- Some rows carry `numero=0` as a placeholder for "no number". The adapter drops those unless a
  postcode is present.
- BAN periodically re-issues `id` values, so a consumer pinning to one snapshot records the
  file's date alongside the corpus version.
- Street vocabulary differs by jurisdiction. `Piste` appears in French Guiana and `Escalier` in
  Mayotte, where neither is common in the metropolitan file, and `decomposeFrStreet` reads them
  from the libpostal `fr` dictionary that all eleven share.

## Fixture

`fixtures/ban/sample.csv` — 18 records under the current 23-column header. Seven cover Paris,
Lyon, Marseille and Nice, including a `bis` row for Champs-Élysées number 1 that exercises the
`rep` composition. Eleven cover the overseas departments, one per jurisdiction plus the Pirae row
whose `nom_voie` is empty, so the street check and the country derivation are both exercised.
Values are synthetic and the columns are BAN's.
