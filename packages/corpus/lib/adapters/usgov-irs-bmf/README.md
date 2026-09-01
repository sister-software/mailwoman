# `usgov-irs-bmf` adapter

IRS Exempt Organizations Business Master File (EO BMF) → `CanonicalRow`. US non-profit
**venue + address** signal (a different organization population than `usgov-nppes`), with strong
**PO-box** coverage — useful `po_box`-tag training data (a tag with historically low recall).

- **Source:** [IRS EO BMF extract](https://www.irs.gov/charities-non-profits/exempt-organizations-business-master-file-extract-eo-bmf).
- **License:** **Public Domain** (US federal). Stamped `"Public Domain"` per row.
- **Coverage:** all US states + territories (per-region CSVs).

## Download

Direct, stable CSV URLs (no auth):

```bash
DIR=/mnt/playpen/mailwoman-data/irs-bmf
mkdir -p "$DIR" && cd "$DIR"
for f in eo1 eo2 eo3 eo4 eo_pr eo_xx; do curl -O "https://www.irs.gov/pub/irs-soi/$f.csv"; done
```

`eo1`..`eo4` are the four US regions; `eo_pr` = Puerto Rico; `eo_xx` = international.

## Run

```bash
npx mailwoman corpus run usgov-irs-bmf --input /mnt/playpen/mailwoman-data/irs-bmf/eo1.csv --country US --limit 50000
# In a full build: adapterInputs["usgov-irs-bmf"] = { inputPath: ".../eoN.csv", country: "US" } per file.
```

## Output

One row per record with a usable city + ZIP. `NAME` → `venue`; the street line is classified as
`po_box` (PO BOX / P.O. BOX / POB / BOX …) or split into `house_number` + `street`; `CITY`/`STATE`/`ZIP`
fill the locality line (`STATE` is already a USPS abbreviation; ZIP+4 is reduced to the 5-digit code).
`source_id` = `usgov-irs-bmf-<EIN>`.

## Format reference

Header: `EIN,NAME,ICO,STREET,CITY,STATE,ZIP,GROUP,SUBSECTION,…` (28 columns, comma-separated, no
quoting). This adapter reads `NAME, STREET, CITY, STATE, ZIP` (+ `EIN` for the id). Full layout: the
[EO BMF data dictionary](https://www.irs.gov/pub/irs-soi/eo_info.pdf).
