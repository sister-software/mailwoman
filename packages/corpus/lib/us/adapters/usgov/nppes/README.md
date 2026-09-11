# usgov-nppes

CMS National Plan and Provider Enumeration System adapter. Consumes the monthly full-replacement NPI CSV.

## Input

The operator pre-downloads the CSV via `fetch-nppes.ts`. The adapter expects columns matching the canonical
"NPPES Full Replacement Monthly NPI File" header.

## Output

One `CanonicalRow` per provider with a populated practice location address (~7M rows). Organization records
carry `venue` (legal business name); individual records carry the composed provider name. The address quad
`(house_number, street, locality, region, postcode)` is parsed from the practice location columns.

## License

US Public Domain (17 U.S.C. § 105 — federal government work product).
