# @mailwoman/dictionaries

Vendored address reference data for Mailwoman, with the functions that locate it:

- `data/libpostal/` holds the [libpostal](https://github.com/openvenues/libpostal) dictionaries
  (MIT), one directory per language.
- `data/chromium-i18n/ssl-address/` holds Google
  [libaddressinput](https://github.com/google/libaddressinput) per-country address metadata
  (Apache-2.0).
- `data/internal/dictionaries/` holds tables this repository curates.

`data/PROVENANCE.md` records which command wrote each directory, and `THIRD_PARTY_NOTICES.md`
states the terms.

## Library

```ts
import { readLibPostalSingleWordStopwords } from "@mailwoman/dictionaries/libpostal"
import { resourceDictionaryPath, sslAddressSpecsPath } from "@mailwoman/dictionaries/paths"

await readLibPostalSingleWordStopwords("fr") // Set { "la", "le", "des", … }
resourceDictionaryPath("libpostal", "en", "street_types.txt")
```

## Refresh the data

`mailwoman dev download libpostal-resources` and `mailwoman dev download ssl-address` run the
acquisition modules under `sdk/` and rewrite the checked-in trees.
