# Changelog

All notable changes are recorded here at a high level. For the full,
authoritative mapping of **which npm version shipped which model and which
capabilities**, see [`docs/articles/releases.mdx`](./docs/articles/releases.mdx)
(rendered at https://mailwoman.ai/releases). Per-release detail
lives in the [GitHub releases](https://github.com/sister-software/mailwoman/releases)
and the per-step eval reports under `docs/articles/evals/`.

## Versioning

All publishable workspaces release **in lockstep** — `mailwoman@4.15.0` pairs
with `@mailwoman/neural-weights-en-us@4.15.0` and every other `@mailwoman/*`
package at the same version. Since `4.0.0`, the npm version is the one that
matters to consumers. The format follows [Keep a Changelog](https://keepachangelog.com)
loosely and [Semantic Versioning](https://semver.org); the public API is still
settling, so treat `4.x` as pre-stable.

## Unreleased

### Added — the Taiwan rooftop tier: a national address-point database from the civil-affairs registers

`台北市中正區重慶南路一段122號` parsed correctly and resolved to Taipei City's point, 5 km from the address, because no
register below the admin ladder existed for Taiwan. `mailwoman situs address-points --country TW` now builds
`address-points/address-points-tw.db` from the Overture-TW parquet (9,712,173 points across 173,642 streets, the
fifteen civil-affairs bureaus in the provenance), and `OvertureNationalDatabaseProvider` serves it in the geocode
session below BAN and above OSM. The register scopes a point by 縣市 + 鄉鎮市區 and carries no postcode, so the
address-point query carries the parse's `region` and `subregion`, and a `zh` reader composes its scope from the pair
(or matches the stored pair by its 鄉鎮市區 tail when the line names no 縣市). The `zh` street locale is the Han fold:
NFKC, 臺 → 台, no whitespace, the 號 dropped from the number, and the sub-number forms `30之19號` / `30號之19` /
`30附40號` falling to the base number. On a 2,000-row draw of the Taiwan board, 1,998 rows answer at the
address-point tier and 1,958 within 100 m of the row's own point; the same probe address answers 25.0399658,
121.5124584 at 1 m. `OGDL-Taiwan-1.0` joins the obligations table, and the situs manifest records an SPDX expression:
the string it stamped before was refused by the manifest check, so the US per-state build had been failing at its last
step. The pre-commit hook read its CLI-freshness reference after the formatter had touched every staged source, so a
commit staging a command file failed with an instruction `yarn compile` could not satisfy; the comparison now runs
first.

### Changed — the CJK base is `v8-cjk-regs` (card 0.0.3): Korean re-sourced, Taiwan added, three registries

`@mailwoman/neural-weights-cjk` 0.0.3 ships the `v8-cjk-regs` graph (#2204). Korean is rebuilt from the ministry's
own 주소DB (a direct download with no application step) in seven registers, including the lot-number form
(`서울특별시 종로구 청운동 52-1`) and the building name; Taiwan is a served locale of the family for the first time, from
Overture-TW in five registers (縣市 → `region`, 鄉鎮市區 → `subregion`, 村里 → `dependent_locality`, 之/樓 → `unit`);
and 1,666,000 typed business addresses from three government registries (Korean permits, Taiwanese companies,
Japanese corporate numbers) trained after each string was aligned exactly against those registers. Against the
0.0.2 base on the same scorer: the JP native register 0.9954 from 0.9921; KR `subregion` 0.9980 from 0.9699 and
`street` 0.9993 from 0.9179 on the 2026 board; TW `region` / `subregion` / `street` / `house_number` 1.0000 / 0.9999 /
0.9992 / 0.9994 from a model that had never seen Taiwan; on typed registry rows, JP `building_name` 0.9880 from 0 and
KR `dependent_locality` 0.9987 from 0.2893. The card names the fifteen Taiwanese civil-affairs bureaus the Open
Government Data License requires. Record: `docs/records/evals/2026-09-08-v8-cjk-regs.md`. The five registers are
`mailwoman corpus fetch` sources (`juso-kr`, `localdata-kr`, `gcis-tw`, `houjin-jp`, `acra-sg`), each fetch writing a
collection manifest with the license label and attribution.

### Added — the CJK overlays join the lockstep release

`@mailwoman/neural-weights-ja-jp` and `@mailwoman/neural-weights-zh-cn` are in the release list. Each is a data-only
overlay over `@mailwoman/neural-weights-cjk`: its locale FST plus a card, with the graph reached through
`mailwoman.baseWeights`. Both names were blessed at 9.3.0; the next release bumps them with every sibling.

### Removed — `@mailwoman/neural-web`

The workspace is deleted and the package will not publish again; 9.3.0 is its last version on npm. Since 9.0.0 it
was a re-export shim over `@mailwoman/neural/web-loader` and `@mailwoman/neural/web-onnx-runner`, the two subpaths
the browser runtime moved to, and re-exporting another package's names is what `mailwoman/no-cross-package-reexport`
refuses everywhere else. A consumer on the shim imports the same names from those two subpaths.

### Fixed — every stamped response body is a named OpenAPI component

`stampedResponseSchema` now takes the component name as a required second argument and registers it. Unnamed, the
intersection it returns was inlined at all eleven call sites, and a generated client had no name to give the type: the
Rust crate's `PhotonResponse` arms became `Variant0`/`Variant1` (positional), and each `/v1` operation grew a flattened
clone of an outcome schema that already had a name. Photon's `/api` + `/reverse` union arm is now
`StampedPhotonFeatureCollection`, Nominatim's three unions share `StampedNominatimResult` and
`StampedNominatimFeatureCollection`, and the five `/v1` bodies are `Stamped{Parse,Geocode}Outcome`,
`Stamped{Batch,Resolve,Format}Response`. The wire bodies are unchanged; the emitted documents gain those components,
and the generated clients name their types after them. This is what turned the `clients` job red on the v9.3.0 release
run — `cargo check --examples` against the drifted `examples/basic.rs`.

### Changed — each package declares the environment variables it reads

`@mailwoman/core/env`'s `$public` now carries only what core reads (the four data roots, `MAILWOMAN_COARSE_PLACER_DIR`,
the license key and URLs) and its `$private` is empty. Every other variable moved to the package that reads it, each a
`liveEnv` view extending core's so a key is declared once beside its reader: the WOF database paths and the development
weights overlay in `@mailwoman/resolver-wof-sqlite/env`; the CLI's runtime and evaluation settings and its rclone
credentials in `mailwoman/env` (which extends the resolver's view); the ONNX thread cap and the PIX1 delta in
`@mailwoman/neural/env`; the corpus, BDC, filer, geocode-oracle and release-kit credentials in each package's `./env`.
`liveEnv` validates one field at a time and caches each until its raw value changes, so an invalid unrelated variable
no longer blocks a valid read. Removed, having no reader: `NODE_ENV`, `CI`, `MAILWOMAN_LOG_ROOT`, `MAILWOMAN_DEMO_URL`,
`HF_TOKEN`, `HF_BUCKET_URI`, `HF_ORG_NAME`, `HF_BUCKET_NAME`, `CF_AUTH_TOKEN`, `GEOCODE_EARTH_API_KEY`, `UK_EPC_TOKEN`,
`USAC_API_KEY_ID`, `USAC_API_SECRET_KEY`, and the twenty training-script and playpen variables. A consumer that read a
moved key from `@mailwoman/core/env` imports the owning package's `./env` instead.

### Added — the shop as data, and `mwops shop`

The Stripe objects the license worker depends on are defined once, in `packages/license-worker/lib/shop/catalog.ts`:
the Product, the two Prices (by lookup key), the Payment Links' shape (the licensee field, the agreement-version
metadata, the success URL, consent collection), the Customer Portal's features and the webhook's events.
`mwops shop status --mode test|live` reads a Stripe account against it; `mwops shop provision --mode … --apply` creates
what is missing, idempotently, and writes the Price ids into `wrangler.toml` and, live, the Payment Links into
`docs/src/license/shop.ts`. The webhook signing secret is answered once and written nowhere. `mwops` is now a view over
three registries. New env: `MAILWOMAN_STRIPE_LIVE_SECRET_KEY`, so a live write is a deliberate act with its own key.
`mwops shop rehearse` and `mwops shop rehearse-renewal` run the renewal path against a deployed worker in test mode: a
customer on a Stripe test clock, a Checkout Session carrying the same collection as the Payment Link
(`checkoutCollection`, one function for both), the clock advanced past the period end, and both tokens' dates reported
with whether the renewed expiry is the new period end plus the grace.

### Added — self-service license: the site and the CLI

`/license` gains a Buy section (the two Payment Links and the billing portal, rendered once the operator fills them in
`docs/src/license/shop.ts`), a section on keeping the key current, and the reason a refunded license keeps verifying
offline until its date. `/license/issued` is the page Stripe returns a buyer to: it polls the worker's claim route and
shows the key, the one-time refresh secret, the `.env` fragment and the two commands to run. `mailwoman license adopt
<token> --secret <s>` writes the key to `$MAILWOMAN_CONFIG_ROOT/license/key` and the credentials to `refresh.json`
(mode 0600); `mailwoman license refresh` fetches the current key after a renewal; neither writes a token this build does
not trust. `verifyConfiguredLicenseKey` reads the key file when `MAILWOMAN_LICENSE_KEY` is unset. `license verify
--online` and `mailwoman doctor` report the per-license status as a fifth word beside the key-id publication: `active`,
`lapsed`, `revoked`, `unknown`, or `unreachable`. New in core: `@mailwoman/core/license/status` (the worker client),
`decodeLicenseKeyPayload`, and the env var `MAILWOMAN_LICENSE_URL`. `mailwoman --version` loads 136 modules, from 132.
The key-id publication gains a word: `unpublished`, when mailwoman.ai answers and has no register at the well-known
path (a 4xx, or a body that is not a register), kept apart from `unreachable`, which stays a network answer. Neither
changes the branch; the doctor names which one it saw.

### Added — `@mailwoman/license-worker` (private)

A Cloudflare Worker that turns a paid Stripe invoice into a signed license token: webhook verification on SubtleCrypto,
fulfilment that re-reads the invoice, subscription and Checkout Session from Stripe by id, a D1 ledger written under
unique constraints so replayed and reordered events mint one token per invoice, an email per token under the invoice
id, and the claim, refresh and status routes the site and `mailwoman license refresh` call. A six-hourly reconciliation
mints what the webhook missed, re-sends what failed, and corrects a license's state against Stripe, including a dispute
ruled in the customer's favour. Sandbox and production are separate Wrangler environments; issuance is off until
`ISSUANCE_ENABLED` is flipped, and refuses whenever the signing key is not an active entry of the shipped register.
Deploys by manual dispatch only (`.github/workflows/license-worker.yml`), which refuses a bundle that imports a Node
builtin. `GET /health` carries `email: ok | failing`, the latter when a token's email has stayed `failed` for over an
hour, so one external check covers the ledger alert and the email alert. The reconciliation's drift sweep reads the
charge behind each active license's current token and revokes on a full refund, the rule the `charge.refunded` handler
applies; a subscription stays `active` through a refund, so a license minted from a missed invoice, or one whose refund
event never arrived, was standing.

### Changed — the license key signs and verifies on WebCrypto

`encodeLicenseKey`, `verifyLicenseKey`, `licenseKeyID`, `generateLicenseSigningKeyPair` and `verifyConfiguredLicenseKey`
answer promises; Ed25519 and the key-id digest run on `crypto.subtle`, so the same module serves Node, a Cloudflare
Worker and a browser. Tokens are unchanged: a key signed by the previous implementation verifies, and the same key and
payload sign to the same bytes. The payload gains two optional fields a self-service issuer sets, `lid` and
`agreement`. The register gains a second active key, `v9-e3d8105a`, the production license worker's; a release carrying it is what lets a purchased key verify. `TRUSTED_LICENSE_SIGNING_KEYS` is replaced by the typed register in `@mailwoman/core/license/register`
(`LICENSE_SIGNING_KEYS`, `trustedLicenseSigningKeys()`, `publishedLicenseKeys()`), which also produces the well-known
file; `mailwoman license register --write` regenerates it and the `license-register` health check refuses drift. The
`./license/key` and `./license/register` subpaths are the Worker-safe imports, held by a bundle test under the
`workerd,worker,browser` conditions; the four Ed25519 helpers leave `@mailwoman/core/hash`.

### Changed — the JSON helpers move to `@mailwoman/core/json`

`parseJSONStrict`, `JSONParseError`, `parseJSONArray`, `tryParsingJSON` and `prettyJSON` are exported from
`@mailwoman/core/json`, no longer from `@mailwoman/core/objects`, whose runtime import of `spliterator` reaches `fs` and
`node:path`. Nothing forwards from the old path.

### Added — the engine stamp and the license notice

Every JSON record the CLI emits (`geocode --json`, `reverse --json`, `autocomplete --json`), every `/v1` body, each
Nominatim result, and the Photon FeatureCollection carry an `engine` object: `name`, `version`, the license branch that
applies (`AGPL-3.0-only` or `LicenseRef-Commercial`), `license_url`, and, under the open-source branch, a one-sentence
`notice`. Every HTTP response from the four servers carries `Server: mailwoman/<version> (<license>)` and
`Link: <https://mailwoman.ai/license>; rel="license"`. Every CLI invocation ends with the same notice on stderr, and each
server prints it once at listen. A valid `MAILWOMAN_LICENSE_KEY` silences the notice; nothing else does. The stamp never
carries the licensee or the key id. Nothing here changes what runs. The page the stamp links to is new:
`https://mailwoman.ai/license`.

### Changed — `mailwoman autocomplete --json` wraps its array

The command emitted a bare JSON array. It now emits `{ "engine": …, "entries": […] }`, so the record carries the
same `engine` stamp as `geocode --json` and `reverse --json`. Read `entries` where you read the array before.

### Added — `nsul.db`, the GB UPRN → unit-postcode register

`mailwoman gazetteer build nsul` builds a sealed, `build-local` layer database from the ONS National Statistics
UPRN Lookup (OGL-UK-3.0) joined to OS Open UPRN's coordinates: one row per GB UPRN whose postcode is in
Code-Point Open and that Open UPRN publishes a point for, carrying the postcode both as NSUL writes it (`RG40 4HR`)
and compacted (`RG404HR`, Code-Point's `spr.name` form). The reader is `NSULLookup` in the new
`@mailwoman/resolver-wof-sqlite/nsul` subpath (`postcodeForUPRN`, `uprnsForPostcode`); the schema and the shared
`compactPostcode` derivation live beside it. Nothing on the parse or resolve path reads it yet — it is the GB
artifact of the physical-constraint design record (#1975), and its runtime surface is a separate proposal.

### Breaking — `@mailwoman/spatial` drops its `./sdk` subpaths

`@mailwoman/spatial/sdk`, `@mailwoman/spatial/sdk/ogr` and `@mailwoman/spatial/sdk/well-known-text` are **removed
outright**, with no deprecated re-export. Replacements:

| Removed                                  | Use                                  |
| ---------------------------------------- | ------------------------------------ |
| `@mailwoman/spatial/sdk/well-known-text` | `@mailwoman/spatial/well-known-text` |
| `@mailwoman/spatial/sdk/ogr`             | `@mailwoman/spatial/tools/ogr`       |
| `@mailwoman/spatial/sdk` (barrel)        | import the module you want, by name  |

`sdk/` in this repository means **data acquisition** (`AGENTS.md`), and neither module acquires anything: one is a
pure WKT/WKB codec, the other shells out to `ogrinfo` to read what a source declares about itself. The barrel is not
replaced by a combined entry on purpose — `@mailwoman/spatial` is imported by browser-facing packages, the root
barrel deliberately excludes both modules, and a combined subpath would put a `node:child_process` reach one
`export *` away from a browser graph.

### Breaking — a retired word is gone from every name in the tree

One word used to stand for four unrelated things: a corpus recipe's output, a per-country postcode database, a
WOF SQLite extract, and the per-region databases the geocode cascade routes between. It is removed everywhere,
with no replacement synonym — each site now takes the noun for the thing it actually names. No shims anywhere.

The new names, by concept:

| Concept                                    | Name now                                                                                                                                                |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the geocode cascade's per-region databases | `mailwoman/geocode-regions`, `RegionDatabaseProvider`, `RegionDatabases`, `RegionDatabaseResolver`, `RegionDatabaseFactory`, `RegionDatabaseCacheEntry` |
| the same, per source register              | `@mailwoman/ban`/`@mailwoman/osm` `sdk/region-database-provider`, `BANRegionDatabaseProvider`, `OSMRegionDatabaseProvider`                              |
| WOF SQLite extracts                        | `@mailwoman/resolver-wof-sqlite/extracts`, `ExtractConfig`, `ResolvedExtract`, `resolveExtracts`, `pickExtractForPlacetype`, `wofExtractPaths`          |
| a corpus recipe and its output             | `@mailwoman/corpus/recipes/*`, `CorpusRecipe`, and a corpus **slice**                                                                                   |
| per-country postcode databases             | `@mailwoman/core/resources/whosonfirst/extract-repo`, and `database` throughout the gazetteer pipeline                                                  |

**Migrating:** search your own source for the retired word — every import that carried it has a same-shaped
replacement in the table above, and nothing changed but the spelling. `repo-health`'s `bannedVocabulary` counter
holds the tree at zero so it cannot return.

### Breaking — `@mailwoman/filer` moves three domain modules out of `./sdk/`

`@mailwoman/filer/sdk/frn`, `@mailwoman/filer/sdk/family-rollup` and `@mailwoman/filer/sdk/filer-lookup` become
`@mailwoman/filer/frn`, `@mailwoman/filer/family-rollup` and `@mailwoman/filer/filer-lookup`. No shims. All three
are also re-exported from the package root, so `@mailwoman/filer` itself keeps resolving them.

They are identity and corporate-family readers, not acquisition — and they were exactly the symbols a request path
needed: `@mailwoman/mcp`'s CLI imported `familyRollup`, `filerLookup`, `toFRN` and `FRN` from the `./sdk` barrel,
which `export *`s seventeen modules, so an MCP request path carried the SEC and CORES HTTP clients and the EDGAR
ingest along to reach three functions. That import now names the three modules, and `dependency-cruiser`'s
`no-serve-package-to-build-tooling` counts `mcp` as a serve package so the edge cannot come back.

The rest of `filer/lib/sdk/` and all of `bdc/lib/sdk/` are unchanged: no serve path reaches them, and renaming them
would spend published subpaths on a naming preference rather than a measured violation.

## Notable releases

### 4.15.0 — postcode-anchor fix (`v1.9.3a3-anchor-absorption`)

A leading 5-digit token that is actually a US house number which happens to
look like a ZIP (`12345 Main St`) is now labeled `house_number` with the
postcode anchor on (the `SLICE-H` case: 20 → 100), at zero coordinate cost
(#220/#723). Trades a coordinate-invisible −2 us.postcode label-F1 on the rare
leading-postcode (VT E911) case.

### 4.14.0 — Australian word-order (`v1.9.2-multilocale-au`)

G-NAF-driven AU support; AU @25 km resolve rate 65 → 87.

### 4.11.0 — French admin split (`v1.8.0-fr-admin-split`)

First model to beat `v1.5.0` on the **shipped assembled coordinate** (not
label-F1) by teaching the locality↔adjacent-admin-token split on non-US
formats. FR coord p50 42 → 2.2 km; US flat.

### 4.4.0 — boundary consolidation

Closed the parity campaign's last empty tags — `po_box` 0 → 89, `cedex` 0 → 96,
intersections 0 → 100 (real-OOD) — and conditional the perturbation arena floor.

### 4.2.0 — gazetteer-anchored consolidation

Locality / region lifts and `country` 0 → 89.8 via the gazetteer soft anchor;
the late-emergent affix tags born.

### 4.1.0 — unit designators

`unit` 0 → 92.3 on real-OOD designators — the first parity-campaign headline.

### 4.0.0 — first neural release

The retrieval-augmented neural sequence labeler ships as the default parser,
replacing the v0 rule engine on noisy/degraded input.

---

_Earlier `2.x`/`3.x` releases predate the neural rewrite; see the GitHub
releases for that history._
