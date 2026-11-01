# usgov-nppes

CMS National Plan and Provider Enumeration System adapter. Consumes the monthly full-replacement NPI CSV.

## Input

The operator pre-downloads the CSV via `fetch-nppes.ts`. The adapter expects columns matching the canonical
"NPPES Full Replacement Monthly NPI File" header.

## Output

One `CanonicalRow` per provider with a populated practice location address (~7M rows). An organization record
sets `venue` to the legal business name. An individual record sets it to the composed provider name. The address quad
`(house_number, street, locality, region, postcode)` is parsed from the practice location columns.

A row's `unit` comes from either address line. A secondary unit written at the end of the first line
(`2560 HUNTINGTON AVE STE 302`) is split off the street by `splitTrailingUnit` in `lib/us/street-unit.ts`. A second
line that opens with a designator or a number sign (`SUITE 200`, `#200`) follows it. The other second lines (`ATTN:
BILLING`, `C/O …`) are left out of the row.

## License

US Public Domain (17 U.S.C. § 105 — federal government work product).
