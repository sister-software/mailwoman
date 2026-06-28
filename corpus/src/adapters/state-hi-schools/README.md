# state-hi-schools

Hawaii State Department of Education K-12 school directory adapter.

## Input

The operator pre-builds a CSV via `corpus/scripts/fetch-sources/fetch-state-hi-schools.ts`. The script downloads the official `SchoolList.xlsx` workbook and concatenates both sheets (`HIDOE` — district-operated schools, `PCS` — public charter schools) into a single flat CSV that shares the workbook's lowercased header (`code,name,address,city,zip,...`).

## Output

One `CanonicalRow` per school (~300 statewide). `venue` is the school name; the address quad `(house_number?, street, locality, region=HI, postcode)` is parsed from the single-line `address` column. `source_id` is `state-hi-schools-<code>` where `<code>` is the HIDOE numeric school identifier.

Hawaii's hyphenated residential numbering (Oahu Windward `47-470 Hui Aeko Place`, Kauai `2-4035 Kaumualii Hwy`) is preserved verbatim by the shared `HOUSE_NUMBER_PREFIX` regex.

The workbook's `island` and `district` columns are HIDOE administrative labels (not US counties) and are intentionally dropped — the canonical `subregion` slot is left empty.

## License

`Public Domain` per Hawaii state government open-data terms. Source: <https://www.hawaiipublicschools.org/DOE%20Forms/SchoolList.xlsx>.
