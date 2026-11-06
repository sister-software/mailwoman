# @mailwoman/registry

A generated, typed registry of standardized identifiers and their relationships. This release holds ISO
3166-1 country codes (alpha-2, alpha-3, numeric) and IATA airport codes, compiled from pinned open sources
into RGY1 lookup artifacts, with branded TypeScript types, a synchronous reader, a Rust compiler and lookup
core, and a WebAssembly batch adapter.

The package is a registry and a query engine. `AUS` is Australia under `iso3166-1-alpha3` and
Austin-Bergstrom International Airport under `iata-location`, and this package answers both. The choice
between them for a free-text address belongs to Mailwoman, in `@mailwoman/resolver`.

## What it answers

```ts
import { getAirportByIATA, airportsInCountry } from "@mailwoman/registry/iata/airports/records"
import { isAirportCode } from "@mailwoman/registry/iata/airports/validate"
import { isCountryCodeAlpha2, parseCountryCodeAlpha2 } from "@mailwoman/registry/iso3166/alpha2"
import { isCountryCodeAlpha3 } from "@mailwoman/registry/iso3166/alpha3"
import { getCountryByAlpha3 } from "@mailwoman/registry/iso3166/records"
import { alpha2ForAlpha3 } from "@mailwoman/registry/iso3166/relations"
import { canonicalSpelling } from "@mailwoman/registry/normalize"
import { interpretCountryOrAirportCode, isCountryAirportCollision } from "@mailwoman/registry/overlap/country-airport"

isCountryCodeAlpha2("GB") // true
parseCountryCodeAlpha2("gb") // { ok: false, reason: "case", input: "gb" }
isCountryCodeAlpha3("AUS") // true
alpha2ForAlpha3("AUS") // "AU"
getCountryByAlpha3("DDR") // { alpha3: "DDR", status: "formerly-used", … }: readable, outside the strict brand
isAirportCode("SFO") // true
getAirportByIATA("AUS")?.country // "US"
airportsInCountry("AU").length // the airports OurAirports places in Australia

isCountryAirportCollision("AUS") // true
interpretCountryOrAirportCode("AUS")
// [
//   { system: "iso3166-1-alpha3", code: "AUS", country: "AU", entityId: "wikidata:Q408", name: "Australia" },
//   { system: "iata-location", code: "AUS", kind: "airport", country: "US", countryStatus: "iso3166-1", entityId: "ourairports:3632", name: "Austin Bergstrom International Airport" },
// ]

canonicalSpelling(" aus ") // { value: "AUS", trimmed: true, uppercased: true }
```

Every predicate is strict: canonical case and length, membership in the built profile. `canonicalSpelling`
is the explicit step that trims and upper-cases, and it reports what it did. A miss means
`not-found-in-snapshot`: the source holds no such code, and the issuing authority may still have assigned
it. `inspectArtifact` reads an artifact's profile, sources and coverage.

Each subpath retains its own artifact and no other. `iso3166/alpha2` carries an 85-byte bitset;
`overlap/country-airport`'s `isCountryAirportCollision` carries the 2,197-byte collision bitset;
`interpretCountryOrAirportCode` carries the two record artifacts (51 KB and 1.1 MB). The root entry
re-exports the subpaths and decodes an artifact at its first call.

## Brands

`ISO.CountryCode_3166_1_Alpha2`, `ISO.CountryCode_3166_1_Alpha3`, `ISO.CountryCode_3166_1_Numeric`,
`IATA.LocationCode`, `IATA.AirportCode` and `ICAO.LocationIndicator` are declaration-only brands. A predicate
narrows a `string` to its brand; the compiler refuses one brand where another is expected. A branded value
records that the validator accepted it under the built profile at the time of the call.

## WebAssembly batches

```ts
import { readFile } from "node:fs/promises"

import { createRegistry, preferredWasmVariant, registryWasmURL, ClassifyMask } from "@mailwoman/registry/wasm"

const registry = await createRegistry({ wasm: await readFile(registryWasmURL(preferredWasmVariant())) })
const packed = new TextEncoder().encode("AUSSFOGBR") // count × 3 bytes
const masks = new Uint8Array(3)

registry.countryAirport.classifyManyInto(packed, masks)
// masks[0] === ClassifyMask.Country | ClassifyMask.Airport | ClassifyMask.Collision
```

The caller loads the module bytes, and `createRegistry` compiles them. `registryWasmURL` locates the
committed `wasm/registry.wasm` and `wasm/registry-simd.wasm`, and `preferredWasmVariant` reports which the
host runs. One call classifies the whole batch, and the staging buffers are reused while they fit.
`docs/performance.md` measures where the batch kernel's per-code cost falls below the TypeScript reader's
(from about 256 codes, over bytes the caller already holds) and where it stays above it (strings, one code
at a time).

## Sources and profile

The built profile is `open-2026-11`: Wikidata's ISO 3166-1 claims (CC0) and OurAirports' `airports.csv`
(public domain), pinned by SHA-256 in `data/manifests/sources.lock.json`. `docs/data-policy.md` states the
terms, what the profile holds and leaves out, and why the UN M49 crosswalk is recorded as not elected.
`data/manifests/coverage.json` declares each namespace's count and status mix.

## Layout and tooling

`docs/rgy1.md` is the normative artifact layout. `crates/registry-build` compiles the normalized JSON into
artifacts, `crates/registry-core` is the `no_std` reader and lookup core, and `crates/registry-wasm` is the
C-ABI adapter. The TypeScript reader in `lib/rgy1/` follows the same document and is checked against an
independent byte walker and against the Rust reader over the same fixture artifacts.

| Command                                                           | Does                                                                                                             |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `node packages/registry/sdk/fetch.run.ts [--repin]`               | Downloads the pinned sources into the data root and checks or rewrites the lock                                  |
| `node packages/registry/tools/normalize.run.ts`                   | Writes `data/normalized/*.json` and `data/manifests/coverage.json`                                               |
| `node packages/registry/tools/generate.run.ts [--check]`          | Compiles the artifacts, writes `lib/artifacts/*.ts` and `data/manifests/artifacts.json`, recompiles the fixtures |
| `node packages/registry/tools/generate-sections.run.ts [--check]` | Writes the section constants TypeScript and Rust share                                                           |
| `node packages/registry/tools/build-wasm.run.ts [--check]`        | Builds `wasm/registry.wasm` and `wasm/registry-simd.wasm`                                                        |
| `node packages/registry/tools/bench.run.ts [--json]`              | Measures the arms and prints the report                                                                          |
| `cargo test -p registry-core`                                     | The Rust conformance suite over the fixture profile                                                              |

## Follow-up

ISO 3166-2 subdivisions, ISO 639 language codes, ISO 15924 scripts, UN M49 regions, BCP 47, Unicode locale
identifiers, UN/LOCODE, metropolitan IATA codes and Zod adapters are tracked as later milestones of
sister-software/mailwoman#2945 and are not in this package.
