# mailwoman

**A calibrated, retrieval-augmented postal-address parser.**

Mailwoman parses free-text postal addresses into structured components (house
number, street, locality, region, postcode, country, …) and resolves them to
coordinates via a gazetteer. It is the user-facing CLI and library entry point
for the Mailwoman ecosystem.

```bash
# CLI — parse an address
npx mailwoman parse "1600 Amphitheatre Parkway, Mountain View, CA 94043"
```

```ts
// Library — parse programmatically
import { createRuntimePipeline, decodeAsJson } from "mailwoman"
import { NeuralAddressClassifier } from "@mailwoman/neural"

const classifier = await NeuralAddressClassifier.loadFromWeights({ locale: "en-US" })
const parse = createRuntimePipeline({ classifier })

const { tree } = await parse("1600 Amphitheatre Parkway, Mountain View, CA 94043")
console.log(decodeAsJson(tree))
// { region: "CA", locality: "Mountain View", street: "Amphitheatre",
//   house_number: "1600", street_suffix: "Parkway", postcode: "94043" }
```

## What it does

Mailwoman is **not** an LLM and nothing about it is generative. It is a small
transformer encoder (~30M params) doing BIO token classification over a 33-label
address schema — boring NER, which is a feature for short, structured strings.

The design splits the problem in two:

- **The model learns the grammar** — a sequence labeler trained from scratch
  on a diverse corpus of real and synthetic addresses.
- **The gazetteer knows the atlas** — a provenance-tracked Who's On First
  database that resolves parsed components to real-world places and coordinates.

Knowledge arrives at inference as _soft input features_ (anchors) — it
informs, never overrides. If you know RAG from the LLM world, this is RAG
for token classification.

## Installation

```bash
# Parser: CLI + neural runtime + US-English model weights
npm install mailwoman @mailwoman/neural @mailwoman/neural-weights-en-us

# Optional: coordinate resolution (the `geocode` command + `--resolve`)
npm install @mailwoman/resolver-wof-sqlite

# Optional: French model
npm install @mailwoman/neural-weights-fr-fr
```

Requires Node.js ≥ 22.5.1. Without a `neural-weights-*` package the CLI still runs but falls
back to the legacy rule parser (weaker); install the weights to use the neural model.

## CLI

```bash
# Parse an address
mailwoman parse "123 Main St, Springfield, IL 62701"

# Parse with explicit locale
mailwoman parse "10 Rue de la Paix, 75002 Paris" --locale fr-FR

# Geocode an address (requires @mailwoman/resolver-wof-sqlite)
mailwoman geocode "1600 Amphitheatre Pkwy, Mountain View, CA 94043"

# Entity resolution (dedup / cross-dataset matching)
mailwoman registry --sources config.json --out entities.geojson

# Interactive TUI
mailwoman parse --tui
```

## Library API

You supply a neural classifier loaded from a weights package; `createRuntimePipeline` wires
up normalization, locale detection, kind classification, phrase grouping, and token
classification with production-ready defaults.

```ts
import { createRuntimePipeline, decodeAsJson, decodeAsTuples } from "mailwoman"
import { NeuralAddressClassifier } from "@mailwoman/neural"

const classifier = await NeuralAddressClassifier.loadFromWeights({ locale: "en-US" })
const parse = createRuntimePipeline({ classifier })

const result = await parse("350 5th Ave, New York, NY 10118")
```

`result` is a `PipelineResult`:

```ts
result.tree // the parsed address as a hierarchical AddressTree
result.kind // { kind: "structured_address" | "postcode_only" | "locality_only" | …, confidence }
result.locale // detected (or asserted) locale
result.queryShape // structural input priors
result.timing // per-stage wall-clock breakdown
```

Project the tree into the shape you need:

```ts
decodeAsJson(result.tree)
// { region: "NY", locality: "New York", street: "5th",
//   house_number: "350", street_suffix: "Ave", postcode: "10118" }

decodeAsTuples(result.tree)
// [["house_number", "350"], ["street", "5th"], …]
```

The tree is hierarchical and carries calibrated confidence per node:

```ts
for (const root of result.tree.roots) {
	console.log(`${root.tag}: "${root.value}" (${root.confidence.toFixed(2)})`)
	// region: "NY" (0.91) — locality, street, house_number, postcode nest beneath it
}
```

Confidence calibration ships with the weights: `loadFromWeights` applies the bundled
per-locale calibrator, so node confidences are calibrated probabilities (a `0.88` is
right about 88% of the time), not raw scores.

### Options

Factory options configure the pipeline; per-call `PipelineOpts` tune a single parse. The
ones you'll reach for most:

```ts
const parse = createRuntimePipeline({
	classifier,
	resolver, // optional — see "Geocoding" below
	normalizeCase: true, // title-case detected all-caps input before the model (default: off)
})

await parse("350 5TH AVE, NEW YORK, NY 10118", {
	locale: "en-US", // assert a locale instead of detecting it
	hardPlaceCountry: true, // confine resolution to a confidently-detected country (default: on)
	jointReconcile: false, // beam-search decode instead of argmax (default: off)
	arbitrate: false, // union the neural parse with the legacy rule parse (default: off)
})
```

## Geocoding

Resolution turns parsed components into a Who's On First place ID and coordinate. It needs a
gazetteer SQLite database — build one with `mailwoman gazetteer build admin` +
`mailwoman gazetteer build fts`, or point at a prebuilt shard. The resolver is
administrative/postcode-level, not rooftop: it returns place centroids (locality, region,
postcode), not delivery-point coordinates.

```bash
# CLI — resolve while parsing, or geocode directly
mailwoman parse "350 5th Ave, New York, NY 10118" --resolve --resolve-db ./wof.sqlite
mailwoman geocode "1600 Amphitheatre Pkwy, Mountain View, CA 94043"
```

Programmatically, build a `WofSqlitePlaceLookup` backend (from
`@mailwoman/resolver-wof-sqlite`), pass it to `createWOFResolver` (from `@mailwoman/resolver`),
and hand the resolver to `createRuntimePipeline({ classifier, resolver })`. The resolved
`result.tree` roots then carry a `wof:id` and coordinate. See
[Getting started → Adding resolution](https://mailwoman.sister.software/articles/getting-started/)
for the worked example.

## Architecture

Mailwoman's runtime pipeline is a staged coordinator:

```
normalize → query-shape → locale-gate → kind-classifier → phrase-grouper → classifier → decoder
```

Each stage is published as its own `@mailwoman/*` package. The `mailwoman`
package is the umbrella that wires them together as a single `npm install`.

## Packages

| Package                           | Role                                               |
| --------------------------------- | -------------------------------------------------- |
| `mailwoman`                       | CLI + `AddressParser` (you are here)               |
| `@mailwoman/core`                 | Types, pipeline coordinator, decoder, dictionaries |
| `@mailwoman/neural`               | SentencePiece tokenizer + ONNX runtime             |
| `@mailwoman/neural-weights-en-us` | Trained model bundle (en-US)                       |
| `@mailwoman/neural-weights-fr-fr` | Trained model bundle (fr-FR)                       |
| `@mailwoman/normalize`            | Stage 1: input preprocessing                       |
| `@mailwoman/query-shape`          | Stage 1.5: structural priors                       |
| `@mailwoman/locale-gate`          | Stage 2: locale detection                          |
| `@mailwoman/kind-classifier`      | Stage 2.5: query kind classification               |
| `@mailwoman/phrase-grouper`       | Stage 2.7: phrase boundary discovery               |
| `@mailwoman/classifiers`          | Rule-based classifiers                             |
| `@mailwoman/codex`                | Postal reference data                              |
| `@mailwoman/corpus`               | Training corpus pipeline                           |
| `@mailwoman/spatial`              | Spatial utilities                                  |
| `@mailwoman/formatter`            | Address formatting + match key                     |
| `@mailwoman/record`               | Record schema + normalizers                        |
| `@mailwoman/match`                | Block → score → cluster matcher                    |
| `@mailwoman/address-id`           | Stable address primary key                         |
| `@mailwoman/registry`             | Entity resolution application                      |

## Related

- [Documentation & blog](https://mailwoman.sister.software)
- [What Mailwoman Is](https://mailwoman.sister.software/articles/concepts/what-mailwoman-is/)
- [GitHub](https://github.com/sister-software/mailwoman)

## License

Dual-licensed: **[AGPL-3.0-only](https://www.gnu.org/licenses/agpl-3.0.html)** for
open-source use, or a **commercial license** for closed-source use without the AGPL's
source-sharing obligation (contact `teffen@sister.software`). Portions derived from
[Pelias Parser](https://github.com/pelias/parser) remain under MIT, and `@mailwoman/core`
bundles third-party reference data under its own terms — see
[THIRD_PARTY_NOTICES](https://github.com/sister-software/mailwoman/blob/main/THIRD_PARTY_NOTICES.md).
