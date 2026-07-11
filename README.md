<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/static/img/mailwoman-seal-magenta.svg">
    <img src="docs/static/img/mailwoman-seal-navy.svg" alt="" width="96" height="96">
  </picture>
</p>

<h1 align="center">Mailwoman</h1>

<p align="center"><strong>A calibrated, retrieval-augmented postal-address parser.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/mailwoman"><img alt="npm version" src="https://img.shields.io/npm/v/mailwoman?color=ff00b0&label=npm"></a>
  <a href="https://github.com/sister-software/mailwoman/actions/workflows/test.yml"><img alt="Tests" src="https://img.shields.io/github/actions/workflow/status/sister-software/mailwoman/test.yml?branch=main&label=tests"></a>
  <a href="https://www.bestpractices.dev/projects/13577"><img alt="OpenSSF Best Practices" src="https://www.bestpractices.dev/projects/13577/badge"></a>
  <img alt="license" src="https://img.shields.io/npm/l/mailwoman?color=663399">
  <img alt="node version" src="https://img.shields.io/node/v/mailwoman?color=339933">
</p>

<p align="center">
  <a href="https://mailwoman.sister.software/demo"><strong>Live demo</strong></a> ·
  <a href="https://mailwoman.sister.software">Docs & blog</a> ·
  <a href="https://mailwoman.sister.software/articles/getting-started/">Getting started</a>
</p>

<p align="center">
  <img src="docs/static/img/readme-terminal.svg" alt="Terminal session: npx mailwoman parse turns a free-text address into structured JSON components" width="760">
</p>

Mailwoman turns free-text postal addresses into structured components — house number,
street, locality, region, postcode, country — and resolves them to coordinates against an
open gazetteer. It is a small transformer encoder (~30M params) doing BIO token
classification over a 33-label schema. It is **not** an LLM and nothing about it is
generative — boring NER, which is the point for short, structured strings.

It runs in Node.js and the browser, with no Elasticsearch and no multi-gigabyte libpostal
install. The model is about 30 MB and resolves admin/postcode coordinates from a SQLite
gazetteer.

```bash
npx mailwoman parse "1600 Amphitheatre Parkway, Mountain View, CA 94043"
```

## Installation

```bash
npm install mailwoman @mailwoman/neural @mailwoman/neural-weights-en-us
```

That installs the CLI, the neural runtime, and the US-English model weights. For French
addresses, add `@mailwoman/neural-weights-fr-fr`. For coordinate resolution, add
`@mailwoman/resolver-wof-sqlite`.

> [!IMPORTANT]
> Requires Node.js ≥ 24.18.0.

## CLI

```bash
# Parse an address into components
mailwoman parse "350 5th Ave, New York, NY 10118"

# Other output formats
mailwoman parse "350 5th Ave, New York, NY 10118" --format tuple   # or: xml

# Resolve components to a Who's On First place + coordinate (needs a gazetteer DB)
mailwoman parse "350 5th Ave, New York, NY 10118" --resolve --resolve-db ./wof.sqlite

# Geocode (admin/postcode coordinate)
mailwoman geocode "1600 Amphitheatre Pkwy, Mountain View, CA 94043"
```

## Library

```ts
import { createRuntimePipeline, decodeAsJson } from "mailwoman"
import { NeuralAddressClassifier } from "@mailwoman/neural"

const classifier = await NeuralAddressClassifier.loadFromWeights({ locale: "en-US" })
const parse = createRuntimePipeline({ classifier })

const { tree } = await parse("1600 Amphitheatre Parkway, Mountain View, CA 94043")
console.log(decodeAsJson(tree))
// { region: "CA", locality: "Mountain View", street: "Amphitheatre",
//   house_number: "1600", street_suffix: "Parkway", postcode: "94043" }
```

The full library surface — confidence, the per-stage pipeline result, resolution, browser
loading, and configuration — is documented in the [`mailwoman` package
README](./mailwoman/README.md) and in [Getting
started](https://mailwoman.sister.software/articles/getting-started/).

## Drop-in servers

Already running a geocoding stack? Three HTTP servers speak the wire formats your clients
use today — no PostgreSQL, no Elasticsearch, no `osm2pgsql` import:

| Package                               | Speaks                                                | Start it                         |
| ------------------------------------- | ----------------------------------------------------- | -------------------------------- |
| [`@mailwoman/nominatim`](./nominatim) | Nominatim — `/search`, `/reverse`, `/status`          | `npx @mailwoman/nominatim serve` |
| [`@mailwoman/photon`](./photon)       | Photon autocomplete — `/api`, `/reverse` (GeoJSON)    | `npx @mailwoman/photon serve`    |
| [`@mailwoman/libpostal`](./libpostal) | libpostal — `/parse`, `/expand` (no gazetteer needed) | `npx @mailwoman/libpostal serve` |

Point geopy's `Nominatim(domain="localhost:8080")` at the first one and forward + reverse
geocoding keep working. Every result carries an OpenCage-style `annotations` block —
IANA timezone, UN/LOCODE, EU NUTS codes, coordinate formats, sun times, currency —
composed by [`@mailwoman/annotations`](./annotations).

## How it compares

This table compares what each system needs to run, not how well it performs. Mailwoman
began as a fork of Pelias Parser and ships wire-compatible drop-ins for the other three.

|                               | Mailwoman                       | libpostal          | Nominatim                  | Photon                         |
| ----------------------------- | ------------------------------- | ------------------ | -------------------------- | ------------------------------ |
| Footprint                     | ~30 MB model + SQLite gazetteer | multi-GB data blob | PostgreSQL + planet import | Elasticsearch/OpenSearch index |
| Runs in the browser           | ✓ (WebGPU / WASM)               | ✗                  | ✗                          | ✗                              |
| Parse → labeled components    | ✓ with calibrated confidence    | ✓                  | —                          | —                              |
| Forward + reverse geocoding   | ✓ (Who's On First gazetteer)    | ✗ (parse only)     | ✓                          | ✓                              |
| Autocomplete / type-ahead     | ✓ (Photon-compatible API)       | ✗                  | ✗                          | ✓                              |
| Annotations (tz, currency, …) | ✓ OpenCage-style block          | ✗                  | ✗                          | ✗                              |

## How it works

The problem splits in two:

- **The model learns the grammar.** A sequence labeler trained from scratch on a diverse
  corpus of real and synthetic addresses decides which span is a street, a locality, a
  postcode.
- **The gazetteer knows the atlas.** A provenance-tracked Who's On First database resolves
  parsed components to real-world places and coordinates.

Knowledge reaches the model at inference as _soft input features_ (anchors) — it informs,
never overrides. If you know RAG from the LLM world, this is RAG for token classification.
The confidence numbers the parser returns are calibrated probabilities, not heuristic
scores: when it says `0.88`, it is right about 88% of the time.

For the longer version, read [What Mailwoman
Is](https://mailwoman.sister.software/articles/concepts/what-mailwoman-is/).

## Locale coverage

A locale appears here only when a coordinate-graded eval backs it.

| Tier                                 | Locales                                                | What backs the claim                                                                                         |
| ------------------------------------ | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| **1 — first-class, floor-gated**     | US, FR                                                 | Per-tag eval floors gate every release. FR coordinate panel (n=3000): 100% resolve, resolved-p90 6.6 km      |
| **2 — trained + coordinate-paneled** | IT, PT, PL, AT, CZ, DE, AU, BE, ES, NL, CH, HR, DK, FI | Per-locale coordinate panels (n=1000 each), resolved-p90 ≤ 10 km across the set; NL resolved-p50 0.05 km     |
| **3 — trained, thinly measured**     | NO, SE                                                 | Coordinate panels exist, but residual misses are not yet fully characterized. Claims beyond this: unverified |

The [browser demo](https://mailwoman.sister.software/demo) carries the same coverage. Full
receipts live in the [scope declaration](./docs/articles/plan/SCOPE.mdx) and the [eval
reports](./docs/articles/evals/).

## Beyond parse + geocode

`mailwoman` is the entry point to 33 published packages. The rest of the toolkit:

| Package                                             | What it does                                                                                      |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| [`@mailwoman/formatter`](./formatter)               | The inverse of the parser — render components back to a locale-aware string + canonical match key |
| [`@mailwoman/match`](./match)                       | Geocode-first record matcher: block → score → cluster (Fellegi-Sunter)                            |
| [`@mailwoman/registry`](./registry)                 | Resolve messy address records to geocoded entities, export GeoJSON                                |
| [`@mailwoman/address-id`](./address-id)             | Stable address primary key (`<state>.<H3-cell>.<hash>`) for joins + dedup                         |
| [`@mailwoman/annotations`](./annotations)           | The OpenCage-style annotation composer behind the drop-in servers                                 |
| [`@mailwoman/timezone-lookup`](./timezone-lookup)   | Coordinate → IANA timezone (point-in-polygon, `node:sqlite`)                                      |
| [`@mailwoman/un-locode-lookup`](./un-locode-lookup) | Place → UN/LOCODE trade-location codes                                                            |
| [`@mailwoman/nuts-lookup`](./nuts-lookup)           | EU coordinate → NUTS statistical regions                                                          |
| [`@mailwoman/codex`](./codex)                       | Per-address-system postal reference data + branded types                                          |

## License

Mailwoman is dual-licensed:

- **[AGPL-3.0-only](https://www.gnu.org/licenses/agpl-3.0.html)** for open-source use. You
  may use, modify, and redistribute the software, but you must share your modifications and,
  for network services, your source.
- **A commercial license** for closed-source/commercial use without the AGPL's source-sharing
  obligation. Contact `teffen@sister.software`.

Portions of Mailwoman derived from [Pelias Parser](https://github.com/pelias/parser) remain
under the MIT license, and Mailwoman bundles third-party data under its own terms. See
[`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md) for the full attribution list.

---

## Developing Mailwoman

> [!NOTE]
> **This section is for working _on_ Mailwoman in this repository.** If you only want to
> _use_ Mailwoman, the published packages above are all you need — you do not need to clone
> the repo, build anything, or read any further.

Mailwoman is a Yarn 4 monorepo: one root package (`mailwoman`) plus the scoped
`@mailwoman/*` workspaces that compose it. Start with [`AGENTS.md`](./AGENTS.md) for the
orientation map (workspaces, where to read next, the release pipeline) and
[`docs/articles/plan/`](./docs/articles/plan/) for the design record.

```bash
git clone https://github.com/sister-software/mailwoman.git
cd mailwoman
yarn install
yarn compile        # tsc -b across all workspaces
yarn test           # vitest (runs from source, no precompile)
```

### The legacy rule engine

Mailwoman began as a TypeScript fork of [Pelias Parser](https://github.com/pelias/parser), a
rule-based engine: a tokenizer, a set of dictionary/pattern classifiers, and an
`ExclusiveCartesianSolver` that enumerates consistent solutions. That rule engine still
lives in the tree (mostly under `@mailwoman/core` and `@mailwoman/classifiers`) and runs as
a fallback and as one arbitration input. The neural sequence labeler is the primary path
now; the rules are being migrated out gradually as the model and its surrounding stages
replace them, so expect that code to shrink over time. It is repository-internal — consumers
of the published package interact with the neural pipeline, not the solver.

### Contributing

Fork and open a pull request against `main` on a feature branch. Please include unit tests.
The model-work runbook (which evals gate a change, how to add a shard) is
[`docs/articles/plan/CONTRIBUTING_MODEL_WORK.mdx`](./docs/articles/plan/CONTRIBUTING_MODEL_WORK.mdx).

## Acknowledgements

This project stands on the work of the Pelias community, OpenStreetMap, Who's On First,
OpenAddresses, and the wider open-geo ecosystem. See
[`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md).
