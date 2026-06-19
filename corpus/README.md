# @mailwoman/corpus

**BIO-labeled training-corpus pipeline** for the Mailwoman address parser.

Generates sequence-labeling training data from reference sources
(OpenAddresses, libpostal dictionaries, synthetic shards) and assembles them into
the TSV format consumed by the Modal training pipeline. This package produces
the data that trains `@mailwoman/neural-weights-*`.

```ts
// The corpus pipeline is primarily build-time CLI tooling.
// Key entry points:
import { expandGolden } from "@mailwoman/corpus";       // Expand reference addresses
import { synthesizeShard } from "@mailwoman/corpus";    // Generate synthetic training shards
import { alignRow } from "@mailwoman/corpus";           // Align raw address → BIO tokens
import { validateCorpus } from "@mailwoman/corpus";     // Validate corpus integrity
```

## What it produces

The corpus pipeline assembles training data from multiple sources:

| Source | Description |
|--------|-------------|
| **OpenAddresses** | Real government address point data (US, FR, DE, …) |
| **NAD** | National Address Database (US-specific) |
| **libpostal** | Multilingual street/place name dictionaries |
| **Synthetic shards** | Generated address variations (boundary stress, order variants, all-caps) |
| **Overture Maps** | Address theme ingestion (alpha) |

Output format: TSV rows with `raw<TAB>BIO_labels` consumed by the Python
training pipeline (`corpus-python/`).

## Key modules

| Module | Purpose |
|--------|---------|
| **`expand-golden.ts`** | Expand reference addresses into training rows with alignment |
| **`align.ts`** | Tokenize raw address → BIO label sequence |
| **`validate.ts`** | Validate corpus integrity, label coverage, shard balance |
| **`synthesize-*.ts`** | Synthetic shard generators (boundary stress, order variants, etc.) |
| **`ingest/`** | Overture Maps + NAD ingestion |
| **`shard-registry.ts`** | Shard metadata and composition |
| **`stats.ts`** | Per-shard and per-tag statistics |

## Build-time tooling

The corpus is assembled via scripts in `scripts/`:

```bash
# Validate the corpus
node scripts/validate-corpus.mjs

# Rebuild shards
node scripts/build-boundary-stress-shard.mjs

# Corpus statistics
node scripts/corpus-stats.mjs
```

## Design

- **BIO (Begin/Inside/Outside) labeling** over SentencePiece tokens.
- **Character-offset aligned** — labels track the raw string, not the
  normalized form, so the model learns real input distributions.
- **Source-homogeneous shards** — each shard comes from one source, ordered by
  type, so eval splits are honest (no bleed between train and held-out).

## Related

- [`@mailwoman/neural`](../neural) — the runtime that loads and runs the trained model
- [`@mailwoman/neural-weights-en-us`](../neural-weights-en-us) — the trained model itself
- [Corpus Construction concepts](https://mailwoman.sister.software/articles/concepts/corpus-construction/)
- [Training Pipeline concepts](https://mailwoman.sister.software/articles/concepts/training-pipeline/)
- [CONTRIBUTING_MODEL_WORK](https://mailwoman.sister.software/articles/plan/CONTRIBUTING_MODEL_WORK/)

## License

[AGPL-3.0-only](https://www.gnu.org/licenses/agpl-3.0.html)
