# Locale identifiers and support promises

## Intent

Mailwoman needs two things it lacks today.

1. It needs a way to identify languages, scripts and locale tags against the published standards.
2. It needs one canonical list of what it supports.

The operator defined "supported" on 2026-11-14 like this: if Mailwoman reads, parses or retrieves a supported input poorly, or
lacks the corpus to do so, that's a bug, because customers have been told the input works.

## Definitions

A **support promise** is one row with four fields:

| Field                 | Meaning                                                                                                          | Example               |
| --------------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------- |
| `country`             | The ISO 3166-1 alpha-2 country the address is in                                                                 | `US`                  |
| `input`               | The BCP 47 language and script of the text the user typed                                                        | `ja-Jpan`             |
| `embeddedNameScripts` | ISO 15924 scripts allowed in a name span inside an otherwise `input`-script address, such as a restaurant's name | `["Hani"]` for London |
| `depth`               | The deepest component the promise guarantees                                                                     | `locality`            |

The country's own script and the input script are separate fields. That keeps `東京都渋谷区` (`JP`, `ja-Jpan`) apart from
`Shibuya, Tokyo` (`JP`, `en-Latn`), and keeps `ニューヨーク市` (`US`, `ja-Jpan`) apart from `350 5th Ave, New York, NY 10118`
(`US`, `en-Latn`).

Inside the promised depth, a wrong parse or a miss is a bug. Below it, the result must be an explicit unresolved component
rather than a guess.

## Goals

- `@mailwoman/registry` identifies ISO 639 language subtags, ISO 15924 scripts and BCP 47 tags, from a pinned source.
- One committed JSON file declares every promise. The API, the CLI and the docs read that file.
- A docs page renders the support matrix from that file.
- Code refuses a promise that has no passing test.

## Non-goals

- Translation or generated transliteration. The boundary in the deleted page
  `docs/articles/developers/knowledge-base/localization/cross-locale-queries.mdx` (readable at `3ed59fcf8e^`) stands: the
  gazetteer connects writings through recorded names, and an absent name stays unresolved.
- Point-of-interest lookup by a name in another script, such as finding `金龍酒家` by its Chinese name.

## Anti-goals

- A promise without a test. The page would then tell customers something no check can show to be false.
- A second hand-typed list of supported countries. `docs/src/components/CoverageTable/coverage.ts` is one already.

## Approaches

| Approach                                                                                            | Tradeoff                                                                                 |
| --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| **A. Declaration ships in codex, enforced by a repository check and release requirements** (picked) | One file decides. The release verdict, already the deciding check, carries the promise   |
| B. Declaration ships in codex, enforced by a separate test suite                                    | Two systems would decide whether a release may ship                                      |
| C. Declaration in `scope.config.json` with generated copies                                         | Repository-only file, so the shipped copy is generated and every edit needs regeneration |

The operator picked A on 2026-11-14 and asked for the from-scratch form of it, which adds three things:

1. The promise rows replace the locale tiers in `scope.config.json` as the declared claim.
2. Release requirements are generated from the promise rows rather than restated.
3. Each parse and geocode response reports which promise, if any, the query fell inside.

## Design

### Part 1: registry

- Source: the IANA Language Subtag Registry,
  `https://www.iana.org/assignments/language-subtag-registry/language-subtag-registry`. IANA and the IETF publish their
  protocol registries under CC0 1.0 (`https://www.iana.org/help/licensing-terms`, read 2026-11-14). The registry holds every
  BCP 47 subtag: ISO 639 languages, ISO 15924 scripts, ISO 3166-1 and UN M49 regions, variants, and the grandfathered and
  redundant tags. One source therefore covers all three namespaces. It is pinned in `sources.lock.json` like the other
  sources.
- Normalized data: `data/normalized/language-subtags.json`.
- Table format: the generator writes TypeScript table modules under `lib/artifacts/bcp47/`, one per subtag type, rather
  than RGY1 binary artifacts. This is the builder's call. The script table holds 225 rows, and no consumer has measured a
  need for the batch kernel on these codes. RGY1 encoding can follow when one does. Each module imports its rows from a
  sibling `<table>.fixture.json`, one row per line. The operator ruled out a base64 payload on 2026-11-14, because an
  opaque blob in a published tarball slows npm security review. The vocabulary census in `lib/repo-health/checks/debt.ts`
  skips `*.fixture.*` files, because a fixture holds source data verbatim.
- Modules: `lib/iso15924/codes.ts` (script lookup, plus the expansion of combined codes such as `Jpan` to the Unicode
  Script values `Hani`, `Hira` and `Kana`), `lib/iso639/languages.ts` (language subtag lookup), and `lib/bcp47/tag.ts` (parse,
  validate and canonicalize a tag per RFC 5646).

### Part 2: declaration and page

- `packages/codex/lib/support/promises.json` holds the rows, and `packages/codex/lib/support.ts` reads them with types.
  Codex already ships JSON this way (`lib/us/street-suffix.json`), and codex has no runtime dependency on the registry.
- A docs component reads `@mailwoman/codex/support` and renders the matrix on `docs/articles/reference/support.mdx`.
- A row's evidence is derived rather than declared: every gauntlet case under
  `packages/mailwoman/tools/eval-harness/gauntlet/cases/` in the row's country whose letters are all in the row's input
  script. The check reads the cases through `loadRegressionCases`, the loader the gauntlet uses.

### Part 3: enforcement

- The repository check `support-promises` refuses a row when any of these holds:
  - its codes don't parse under the registry, or its input tag isn't canonical or lacks a script subtag;
  - its evidence holds no `pass` case.
- The same check reports each `improvement_target` or `known_fail` case inside a promise as a warning, one open bug
  against that promise.
- The promise rows replaced the tiers on 2026-11-15. `scope.config.json` keeps the training configs and a
  `unpromisedShippingLocales` reason for each shipping country without a promise, and `locale-scope` compares the
  shipping countries with the promises.
- Release requirements read the promises as coverage rather than as thresholds. The `support-promises` check
  warns for each promised country without a country requirement in the current specification. A minimum is a
  measured decision registered in a new specification version, and generating one from a promise row would
  register a threshold nobody measured (the AGENTS.md rule on data-derived thresholds), so the builder left
  thresholds to that process. This is the builder's call.
- `POST /v1/geocode` and `POST /v1/batch` report the matched promise in a `support` field, matched on the resolved
  `countryCode` and the query's script by `@mailwoman/api/support`. The repository check selects evidence with the
  same function. `POST /v1/parse` resolves no country, so it reports none.

## Seed rows

The first declaration holds only rows with passing gauntlet evidence on 2026-11-14. `US × ja-Jpan` is promised at
`locality` depth, because `us/cross-language.jsonl` passes `ニューヨーク` and `ニューヨーク州ブルックリン区`. Its
`ニューヨーク市` case is `improvement_target`, and the check reports it as an open bug against the promise.

CZ and FI sit in tier 2 of `SCOPE.mdx`, but each has one Latin-script gauntlet case and that case fails, so neither
holds a promise yet. DK, HR, NO, KR and TW have no gauntlet directory at all, so their tier claims rest on boards outside
the gauntlet and they hold no promise either.

## Left to the builder

- The exact depth vocabulary, drawn from `ComponentTag`.
- Which tiered countries get a `full-address` row now. Each one needs passing native-script gauntlet rows.
