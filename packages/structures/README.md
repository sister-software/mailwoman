# @mailwoman/structures

This package maintains the source register for building footprints, city models, landmarks, tree heights and basemaps. Each source records its attribution and license decision.

This workspace is private and is used from the Mailwoman repository.

## Read map credits

```ts
import { BASEMAP_INPUTS, Basemap, creditsFor } from "@mailwoman/structures"

const credits = creditsFor(BASEMAP_INPUTS[Basemap.ProtomapsV4])

for (const credit of credits) {
	console.log(credit.text, credit.url)
}
```

`creditsFor` deduplicates source IDs while preserving their order. It throws
when a source is absent from the register or lacks attribution text.
`HILLSHADE_INPUTS` and `CITY_MODEL_INPUTS` identify the sources for those
additional map layers.

## Inspect the register

```ts
import { STRUCTURE_SOURCE_REGISTER, auditStructureRegister, publishProblems } from "@mailwoman/structures"

const problems = auditStructureRegister()

for (const source of STRUCTURE_SOURCE_REGISTER.sources) {
	console.log(source.sourceID, publishProblems(source))
}

console.log(problems)
```

`auditStructureRegister` checks record consistency, including duplicate IDs,
missing license records and jurisdiction mismatches.
`publishProblems` reports the recorded reasons a source cannot be included in a
published layer. An empty result means the register's decision permits all
requested operations. It is not a new review of the publisher's terms.

The default publication operations are `fetch`, `convert`, `adapt`,
`redistribute` and `commercial-sublicense`. The register keeps these decisions
separate from the attribution displayed on the map.

## Source layout

| Path                           | Contents                                        |
| ------------------------------ | ----------------------------------------------- |
| `lib/<cc>/sources.ts`          | A jurisdiction's sources and license decisions. |
| `lib/international/sources.ts` | Sources that span countries.                    |
| `lib/register.ts`              | The assembled register and its audits.          |
| `lib/basemaps.ts`              | Basemap inputs and credit generation.           |
| `data/licenses/`               | Retrieved copies of source terms.               |
| `sdk/`                         | Acquisition tools and catalog readers.          |

Follow [the source-register instructions](AGENTS.md) when adding a source or
recording a new decision. Retrieved license copies are retained as records.
Add a new retrieval rather than rewriting an existing copy.

## PLATEAU city models

[`data/plateau-tilesets.json`](data/plateau-tilesets.json) records the catalog
used for Japanese city models, including dataset license titles and geoid
heights. `electedPlateauTilesets`, exported from
`@mailwoman/structures/jp/plateau`, filters entries by the recorded PLATEAU site
policy title.

Regenerate the catalog from the repository root when refreshing its sources:

```bash
node packages/structures/sdk/plateau-tilesets.run.ts
yarn exec oxfmt packages/structures/data/plateau-tilesets.json
```

This operation contacts the catalog and geoid services and rewrites the generated
JSON. Review the resulting data and source decisions before using it in a layer.

## Verification

```bash
yarn test --run packages/structures
```

The [Earth package](../earth) consumes map credits and city models. The
[tile Worker](../tile-worker) serves map artifacts.

## License

The package declares `AGPL-3.0-only OR LicenseRef-Commercial`.
