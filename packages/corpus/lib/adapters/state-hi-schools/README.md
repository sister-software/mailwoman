# state-hi-schools

Hawaii State Department of Education K-12 school directory adapter.

## Input

Run `mailwoman corpus fetch state-hi-schools` to retain the official `SchoolList.xlsx` workbook with its two sheets: `HIDOE` (district-operated schools) and `PCS` (public charter schools). The adapter reads both sheets directly. Existing flat CSV artifacts from the former conversion pipeline remain accepted.

## Output

One `CanonicalRow` per school (~300 statewide). `venue` is the school name; the address quad `(house_number?, street, locality, region=HI, postcode)` is parsed from the single-line `address` column. `source_id` is `state-hi-schools-<code>` where `<code>` is the HIDOE numeric school identifier.

Hawaii's hyphenated residential numbering (Oahu Windward `47-470 Hui Aeko Place`, Kauai `2-4035 Kaumualii Hwy`) is preserved verbatim by the shared `HOUSE_NUMBER_PREFIX` regex.

The workbook's `island` and `district` columns are HIDOE administrative labels (not US counties) and are intentionally dropped — the canonical `subregion` slot is left empty.

## License

`Public Domain` per Hawaii state government open-data terms. Source: <https://www.hawaiipublicschools.org/DOE%20Forms/SchoolList.xlsx>.
