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
import { AddressParser } from "mailwoman";

const parser = new AddressParser();
const result = await parser.parse("1600 Amphitheatre Parkway, Mountain View, CA 94043");
// result.components.house_number → "1600"
// result.components.street → "Amphitheatre Parkway"
// result.components.locality → "Mountain View"
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

Knowledge arrives at inference as *soft input features* (anchors) — it
informs, never overrides. If you know RAG from the LLM world, this is RAG
for token classification.

## Installation

```bash
npm install mailwoman

# For the geocoder (optional — enables `geocode` command and coordinate resolution)
npm install @mailwoman/resolver-wof-sqlite
```

Requires Node.js ≥ 22.5.1.

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

```ts
import { AddressParser } from "mailwoman";

const parser = new AddressParser({
  locale: "en-US",          // "en-US" | "fr-FR"
  defaultCountry: "US",     // ISO-3166 country for gazetteer scope
});

const result = await parser.parse("1600 Amphitheatre Parkway, Mountain View, CA 94043");

// Structured components
result.components.house_number;   // "1600"
result.components.street;         // "Amphitheatre Parkway"
result.components.locality;       // "Mountain View"
result.components.region;         // "CA"
result.components.postcode;       // "94043"
result.components.country;        // "US"

// Resolved coordinate (when gazetteer is available)
result.coordinate;                // { lat: 37.4224, lon: -122.0842 }

// Per-component confidence
result.confidence.house_number;   // 0.99
result.confidence.street;         // 0.95
```

## Configuration

```ts
const parser = new AddressParser({
  locale: "en-US",
  defaultCountry: "US",
  calibrate: true,            // Enable isotonic confidence calibration
  normalizeCase: false,       // Detect + title-case all-caps input (default: off)
  jointReconcile: false,      // Use joint decoding (default: argmax)
  arbitrate: false,           // Enable rule-vs-neural arbitration (default: off)
});
```

## Architecture

Mailwoman's runtime pipeline is a staged coordinator:

```
normalize → query-shape → locale-gate → kind-classifier → phrase-grouper → classifier → decoder
```

Each stage is published as its own `@mailwoman/*` package. The `mailwoman`
package is the umbrella that wires them together as a single `npm install`.

## Packages

| Package | Role |
|---------|------|
| `mailwoman` | CLI + `AddressParser` (you are here) |
| `@mailwoman/core` | Types, pipeline coordinator, decoder, dictionaries |
| `@mailwoman/neural` | SentencePiece tokenizer + ONNX runtime |
| `@mailwoman/neural-weights-en-us` | Trained model bundle (en-US) |
| `@mailwoman/neural-weights-fr-fr` | Trained model bundle (fr-FR) |
| `@mailwoman/normalize` | Stage 1: input preprocessing |
| `@mailwoman/query-shape` | Stage 1.5: structural priors |
| `@mailwoman/locale-gate` | Stage 2: locale detection |
| `@mailwoman/kind-classifier` | Stage 2.5: query kind classification |
| `@mailwoman/phrase-grouper` | Stage 2.7: phrase boundary discovery |
| `@mailwoman/classifiers` | Rule-based classifiers |
| `@mailwoman/codex` | Postal reference data |
| `@mailwoman/corpus` | Training corpus pipeline |
| `@mailwoman/spatial` | Spatial utilities |
| `@mailwoman/formatter` | Address formatting + match key |
| `@mailwoman/record` | Record schema + normalizers |
| `@mailwoman/match` | Block → score → cluster matcher |
| `@mailwoman/address-id` | Stable address primary key |
| `@mailwoman/registry` | Entity resolution application |

## Related

- [Documentation & blog](https://mailwoman.sister.software)
- [What Mailwoman Is](https://mailwoman.sister.software/articles/concepts/what-mailwoman-is/)
- [GitHub](https://github.com/sister-software/mailwoman)

## License

[AGPL-3.0-only](https://www.gnu.org/licenses/agpl-3.0.html)
