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
require thirteen before a source enters the training set. Read what follows before writing an
adapter ([#2323](https://github.com/sister-software/mailwoman/issues/2323)).

**Address role.** `CanonicalRow.addressRole` says what an address is the address of, from the
`AddressRole` vocabulary in `lib/types.ts`. Every adapter declares one and `runner.ts` stamps it on
each row the adapter leaves unset; an adapter over a source with more than one address column sets
the field per row instead. Taiwan's company register is that case — the registered company address
(公司地址) and the business address the economic ministry records for companies (營業地址) sit in
separate columns of one row, and reading the file without the role field teaches the premise parser
registered-office grammar.

The field is required on `CorpusAdapter` and carries no default, because the answer is a property of
the source that only the adapter's author has read. Ten of the 23 adapters here emit a non-premise
role: four facility (`state-hi-schools`, `usgov-hrsa-fqhc`, `usgov-imls-pls`,
`usgov-samhsa-treatment-locator`), three mailing (`synth-po-box`, `state-tx-notaries`,
`usgov-irs-bmf`), two practice (`usgov-nppes`, `state-ny-notaries`) and one registered-office
(`state-ia-contractors`). A defaulted field would record premise for all ten.

**Assertion per field.** `AssertedProposition` in
[`@mailwoman/evidence`](../evidence/lib/status.ts) records what a publisher asserts, per field, in
six values: `identity`, `address`, `geometry`, `observation`, `grammar`, `routing`. A company
register is an authority on the identifier it issues while the registered-office string on the same
row is an `observation` somebody filed. One verdict for the whole source cannot say both, which is
why `lib/tools/fetch/index.ts` names the assertion and the role per entry rather than grading each
source once. The Korean permit registry (지방행정인허가데이터) is the worked example: it grants
permit identity, and its address string is what a clerk typed in two address systems with no
validation.

**No license decision, only a label.** `license` holds a string, and `utils/license.ts` filters on
its prefix. A dual-licensed source needs a record of which terms the build elects and why — BAN is
`Licence Ouverte` or ODbL, and this project elects the former, which is why that reasoning sits in
a docstring rather than in the data. Still open.

Where the ledger overlaps an existing interface, reuse that shape rather than writing a second
provenance vocabulary. A layer database already embeds `layer_manifest` (`source`,
`source_vintage`, `build_sha`, `license`, `attribution`, `tier`) and `layer_coverage` — see
[the layer interface](../../docs/engineering/reference/layer-interface.mdx).

## The address-source register

`data/address-source-register.json`, read through `@mailwoman/corpus/source-register`, records which
jurisdictions exist, what research has resolved for each, and what is known about every source's
terms. It is a backlog made checkable: **no row in it is ingest-eligible today**, and
`ingestEligibilityProblems()` answers with the reasons rather than a bare `false`.

Two tables. The jurisdiction table enumerates all 250 — every ISO 3166-1 alpha-2 code plus the
operational `XK` — whether or not anybody found a source; the source table holds 389 rows across 240
of them. A jurisdiction with no sources states `researchState` and a `stateReason`, so "nobody has
looked yet" is written down rather than inferred from an empty list.

`readAddressSourceRegister()` refuses a register that fails its audit. Regenerate it with
`mailwoman corpus source-register`; `data/PROVENANCE.md` carries the command, the input row counts,
and the three fields no row resolved.

### When a jurisdiction has no row yet

The research pass recorded eight global discovery lookups once per jurisdiction — 2,000 of the
2,389 rows it produced, collapsing to eight distinct bodies. They name a lookup to perform rather
than a national source, so they are this procedure and not register rows. Work them in order for a
jurisdiction the register calls `unexamined`, and promote what you resolve into a source row.

| Sector               | Lookup                                                                                                                                         |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| business/legal       | GLEIF Global LEI Index, the jurisdiction's own slice                                                                                           |
| business register    | GLEIF Registration Authorities List, for the local official register                                                                           |
| health               | the national Health Facility Master List, discovered or validated through the WHO's geolocated health-facility data                            |
| education            | the national school register or EMIS, with Giga Maps' government-sourced records as a discovery layer                                          |
| telecom              | the national regulator's licensee and spectrum or operator registers, located through the ITU's member-state entities                          |
| universal service    | national universal-service project, beneficiary and award records, with fund status through the ITU DataHub                                    |
| procurement/grants   | the national e-procurement, supplier or award register, and the Open Contracting Partnership's data registry where the country publishes to it |
| environment/industry | the national pollutant-release register or industrial permit register, located through PRTR.net or the OECD                                    |

A global aggregator is a locator, never the source. When one carries a national official record,
keep the national publisher's provenance — the register has `publisher` and `sourceURL` fields for
exactly that, and the one `verified-corpus-stale` row is what happens when an aggregator's copy
stops and nobody checked the national portal behind it.

## Related

- [`@mailwoman/neural`](../neural) — the runtime that loads and runs the trained model
- [`@mailwoman/neural-weights-en-us`](../neural-weights-en-us) — the trained model itself
- [Corpus Construction concepts](https://mailwoman.ai/articles/concepts/corpus-construction/)
- [Training Pipeline concepts](https://mailwoman.ai/articles/concepts/training-pipeline/)
- [CONTRIBUTING_MODEL_WORK](https://github.com/sister-software/mailwoman/blob/main/docs/engineering/CONTRIBUTING_MODEL_WORK.mdx)

## License

[AGPL-3.0-only](https://www.gnu.org/licenses/AGPL-3.0.html)
