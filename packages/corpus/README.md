# @mailwoman/corpus

**BIO-labeled training-corpus pipeline** for the Mailwoman address parser.

Generates sequence-labeling training data from reference sources
(OpenAddresses, libpostal dictionaries, synthetic training-data subsets) and assembles them into
the TSV format consumed by the Modal training pipeline. This package produces
the data that trains `@mailwoman/neural-weights-*`.

```ts
// The corpus pipeline is primarily build-time CLI tooling.
import { buildCorpus, RECIPES_BY_NAME, runAdapter } from "@mailwoman/corpus"
import type { CanonicalRow, LabeledRow } from "@mailwoman/corpus/types"
import { alignRow } from "@mailwoman/corpus/utils"
```

`alignRow` lives on `./utils` rather than the barrel; the barrel re-exports `#adapters`,
`#build`, `#runner`, `#recipes/index` and `#types` only.

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

| Module                      | Purpose                                                                |
| --------------------------- | ---------------------------------------------------------------------- |
| **`types.ts`**              | `CanonicalRow`, `LabeledRow`, `SourceProvenance`, `CorpusAdapter`      |
| **`utils/align.ts`**        | Tokenize raw address → BIO label sequence; quarantine what refuses     |
| **`build.ts`**              | Drive the end-to-end build, write `labeled.jsonl` + `quarantine.jsonl` |
| **`runner.ts`**             | Run one adapter or all of them, and emit the run manifest              |
| **`synthesizers/*.ts`**     | Synthetic row generators (boundary stress, order variants, etc.)       |
| **`recipes/index.ts`**      | The synthetic-corpus recipe registry (`CorpusRecipe` by name)          |
| **`tools/fetch/index.ts`**  | The acquisition registry — one entry per external source               |
| **`tools/corpus-stats.ts`** | Per-source and per-tag statistics                                      |

## Layout

The top-level ownership boundary is the address system, using ISO 3166-1 alpha-2 country
directories. A directory owns its recipes, source adapters, acquisition tools, and tests together:
`fr/{recipes,adapters,tools}`, `kr/{adapters,tools}`, and
`us/{adapters,tools}` are representative. Regional and global work lives under `south-asia/` and
`international/`; cross-locale primitives remain at the `recipes/` and `synthesizers/` roots.

Sources that deliberately span countries (OpenAddresses, GeoNames, Overture, OSM, and WOF) remain
under `adapters/`, with their common fetching and processing utilities under `tools/`. Source kind
is therefore a nested concern inside a country directory rather than the package's organizing principle.
Tests live beside the module they cover: `fr/adapters/ban/adapter.test.ts` belongs with
`fr/adapters/ban/adapter.ts`. Production compilation excludes `*.test.ts`; the test project includes
the same pattern. Public subpaths use this same locale-first layout.

## Build-time tooling

Every entry point is a `mailwoman` command. This package has no `scripts/` directory, and the
`no-root-scripts` health check refuses a path that names one.

```bash
# Build one recipe's output
mailwoman corpus slice boundary-stress --count 10000 --out /tmp/boundary-stress.jsonl

# Acquire a source named in the fetch registry
mailwoman corpus fetch geonames-postal
```

## Design

- **BIO (Begin/Inside/Outside) labeling** over SentencePiece tokens.
- **Character-offset aligned** — labels track the raw string rather than the
  normalized form, so the model learns real input distributions.
- **Source-homogeneous subsets** — each training-data subset comes from one source, ordered by
  type, so eval splits are clean (no bleed between train and held-out).

## Source provenance

`SourceProvenance` (`lib/types.ts`) stamps four fields on every row: `source`, `source_id`,
`corpus_version`, `license`. The acceptance rules in the global address corpus specification
require thirteen before a source enters the training set. Three of the absences change what a
row teaches, so read them before writing an adapter
([#2323](https://github.com/sister-software/mailwoman/issues/2323)).

**No address role.** A registered-office string and a premise string land in the same
`CanonicalRow.components` with nothing separating them. Taiwan's company register carries both
on one row in separate columns — the registered company address (公司地址) and the business
address the economic ministry records for companies (營業地址) — so an adapter that reads the
file without a role field teaches the premise parser registered-office grammar. Most
functional-authority sources (company, health, education, telecom, procurement registers) emit a
non-premise role.

**No assertion per field.** A company register can be authoritative for entity identity while the
registered-office string it holds is an operational observation somebody filed. One verdict for
the whole source cannot say both.

**No license decision, only a label.** `license` holds a string, and `utils/license.ts` filters on
its prefix. A dual-licensed source needs a record of which terms the build elects and why — BAN is
`Licence Ouverte` or ODbL, and this project elects the former, which is why that reasoning sits in
a docstring rather than in the data.

`lib/tools/fetch/index.ts` grades each acquisition source `LABEL` or `NOISY`. That is one verdict
per source, and it is being replaced by per-field assertion plus address role. The Korean permit
registry (지방행정인허가데이터) shows why: it assigns permit identity with authority, and its
address string is what a clerk typed in two address systems with no validation.

Where the ledger overlaps an existing contract, reuse that shape rather than writing a second
provenance vocabulary. A layer database already embeds `layer_manifest` (`source`,
`source_vintage`, `build_sha`, `license`, `attribution`, `tier`) and `layer_coverage` — see
[the layer contract](../../docs/engineering/reference/layer-contract.mdx).

## Related

- [`@mailwoman/neural`](../neural) — the runtime that loads and runs the trained model
- [`@mailwoman/neural-weights-en-us`](../neural-weights-en-us) — the trained model itself
- [Corpus Construction concepts](https://mailwoman.ai/articles/concepts/corpus-construction/)
- [Training Pipeline concepts](https://mailwoman.ai/articles/concepts/training-pipeline/)
- [CONTRIBUTING_MODEL_WORK](https://github.com/sister-software/mailwoman/blob/main/docs/engineering/CONTRIBUTING_MODEL_WORK.mdx)

## License

[AGPL-3.0-only](https://www.gnu.org/licenses/agpl-3.0.html)
