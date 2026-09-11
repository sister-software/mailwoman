# @mailwoman/corpus

**BIO-labeled training-corpus pipeline** for the Mailwoman address parser.

Generates sequence-labeling training data from reference sources
(OpenAddresses, libpostal dictionaries, synthetic training-data subsets) and assembles them into
the TSV format consumed by the Modal training pipeline. This package produces
the data that trains `@mailwoman/neural-weights-*`.

```ts
// The corpus pipeline is primarily build-time CLI tooling.
// Key entry points:
import { expandGolden } from "@mailwoman/corpus" // Expand reference addresses
import { synthesizeSlice } from "@mailwoman/corpus" // Generate synthetic training rows
import { alignRow } from "@mailwoman/corpus" // Align raw address → BIO tokens
import { validateCorpus } from "@mailwoman/corpus" // Validate corpus integrity
```

## What it produces

The corpus pipeline assembles training data from multiple sources:

| Source             | Description                                                              |
| ------------------ | ------------------------------------------------------------------------ |
| **OpenAddresses**  | Real government address point data (US, FR, DE, …)                       |
| **NAD**            | National Address Database (US-specific)                                  |
| **libpostal**      | Multilingual street/place name dictionaries                              |
| **Synthetic rows** | Generated address variations (boundary stress, order variants, all-caps) |
| **Overture Maps**  | Address theme ingestion (alpha)                                          |
| **OpenStreetMap**  | Pakistan, Bangladesh, Vietnam — ODbL, dropped by `--exclude-share-alike` |

Output format: TSV rows with `raw<TAB>BIO_labels` consumed by the Python
training pipeline (`corpus-python/`).

## Key modules

| Module                  | Purpose                                                          |
| ----------------------- | ---------------------------------------------------------------- |
| **`expand-golden.ts`**  | Expand reference addresses into training rows with alignment     |
| **`align.ts`**          | Tokenize raw address → BIO label sequence                        |
| **`validate.ts`**       | Validate corpus integrity, label coverage, subset balance        |
| **`synthesizers/*.ts`** | Synthetic row generators (boundary stress, order variants, etc.) |
| **`ingest/`**           | Overture Maps + NAD ingestion                                    |
| **`slice-registry.ts`** | Subset metadata and composition                                  |
| **`stats.ts`**          | Per-subset and per-tag statistics                                |

## Layout

The top-level ownership boundary is the address system, using ISO 3166-1 alpha-2 country
directories. A directory owns its recipes, source adapters, acquisition tools, and tests together:
`fr/{recipes,adapters,tools}`, `kr/{adapters,tools}`, and
`us/{adapters,tools}` are representative. Regional and global work lives under `south-asia/` and
`international/`; cross-locale primitives remain at the `recipes/` and `synthesizers/` roots.

Sources that deliberately span countries (OpenAddresses, GeoNames, Overture, OSM, and WOF) remain
under `adapters/`, with their common fetching and processing utilities under `tools/`. Source kind
is therefore a nested concern inside a country directory, not the package's organizing principle.
Tests live beside the module they cover: `fr/adapters/ban/adapter.test.ts` belongs with
`fr/adapters/ban/adapter.ts`. Production compilation excludes `*.test.ts`; the test project includes
the same pattern. Public subpaths use this same locale-first layout.

## Build-time tooling

The corpus is assembled via scripts in `scripts/`:

```bash
# Validate the corpus
node scripts/validate-corpus.mjs

# Rebuild slices
node scripts/build-boundary-stress-slice.mjs

# Corpus statistics
node scripts/corpus-stats.mjs
```

## Design

- **BIO (Begin/Inside/Outside) labeling** over SentencePiece tokens.
- **Character-offset aligned** — labels track the raw string, not the
  normalized form, so the model learns real input distributions.
- **Source-homogeneous subsets** — each training-data subset comes from one source, ordered by
  type, so eval splits are clean (no bleed between train and held-out).

## Related

- [`@mailwoman/neural`](../neural) — the runtime that loads and runs the trained model
- [`@mailwoman/neural-weights-en-us`](../neural-weights-en-us) — the trained model itself
- [Corpus Construction concepts](https://mailwoman.ai/articles/concepts/corpus-construction/)
- [Training Pipeline concepts](https://mailwoman.ai/articles/concepts/training-pipeline/)
- [CONTRIBUTING_MODEL_WORK](https://github.com/sister-software/mailwoman/blob/main/docs/engineering/CONTRIBUTING_MODEL_WORK.mdx)

## License

[AGPL-3.0-only](https://www.gnu.org/licenses/agpl-3.0.html)
