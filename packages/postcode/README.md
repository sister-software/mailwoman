# `@mailwoman/postcode`

Postcode evidence read from a postcode's form.

- `POSTCODE_SHAPES` and `wholePostcodeShape` find the spans of a line that have a postcode's shape, without
  knowing the country. `shapes.json` holds the records, and the Python trainer reads the same file.
- `postcodeSyntax` and `acceptPostcode` check a whole value against one country's postcode
  syntax, generated from Google's libaddressinput by
  `packages/mailwoman/tools/dev-tools/postcode/country-formats.ts`.
- `countryFromPostcodeFormat` and `countriesFromPostcodeFormat` return the countries a whole postcode's form
  implies.
- `candidateSystemsForPostcode` returns the codex address systems whose own postcode normalizer accepts a
  value.

```ts
import { countriesFromPostcodeFormat } from "@mailwoman/postcode"

countriesFromPostcodeFormat("110 00") // ["CZ", "SK", "SE", "GR"]
```

Every answer here comes from syntax. A dictionary of observed postcodes, prefix ancestry and the
decoder and resolver consumers join this package in the steps tracked by #2679.
