# @mailwoman/gazetteer

This package reads Who's On First (WOF) records and builds the geographic data that
Mailwoman's resolvers consume. Its library provides placetype definitions, record
readers and hierarchy helpers. Its `tools/` modules build administrative, postcode,
POI and address layers, along with search indexes and coverage manifests.

For place lookup, use [`@mailwoman/resolver-wof-sqlite`](../resolver-wof-sqlite).
For resolving spans in a parsed address, use [`@mailwoman/resolver`](../resolver).
Gazetteer databases are built and distributed separately from this package's code.

## Installation

```bash
npm install @mailwoman/gazetteer
```

The package requires Node.js `^24.22.1 || >=26.12.1`. The `mailwoman gazetteer`
commands described below come from the separate `mailwoman` package.

## Compare placetypes

```ts
import {
	isAtLeastAsSpecific,
	isStrictlyFiner,
	placetypeSpecificity,
} from "@mailwoman/gazetteer/whosonfirst/placetypes/specificity"

isStrictlyFiner("locality", "region") // true
isAtLeastAsSpecific("locality", "locality") // true
placetypeSpecificity("custom") // null
```

Higher specificity ranks mean finer geographic units. WOF's numeric placetype IDs
follow assignment order. Use these helpers when comparing geographic specificity.
Both comparison functions return `null` when either placetype is unranked, leaving
the caller to decide how to handle it.

The module also exports `SETTLEMENT_PLACETYPES`, `SUB_LOCALITY_PLACETYPES` and
`REGION_AND_COARSER_PLACETYPES`. The static rank for `postalcode` describes the
placetype ordering. The resolver applies additional rules when choosing between
a postcode and a locality for an address.

## Read a local WOF record

Given a cloned WOF repository under `/data/wof-repos`, resolve its data directory
before reading a record:

```ts
import { readWOFFeature, resolveWOFDataDir } from "@mailwoman/gazetteer/whosonfirst/extract-repo"

const dataDir = await resolveWOFDataDir("/data/wof-repos", "admin", "US")

if (dataDir === null) {
	throw new Error("The US administrative repository is missing")
}

const feature = await readWOFFeature(85977539, [dataDir])

if (feature !== null) {
	console.log(feature.properties["wof:name"], feature.properties["wof:placetype"])
}
```

`resolveWOFDataDir` accepts both `<root>/whosonfirst-data/<repo>` and `<root>/<repo>`
layouts. Country codes are lowercased when constructing repository names.
`readWOFFeature` takes roots that already point into each repository's `data`
directory. It derives `859/775/39/85977539.geojson` from the example ID.

The reader returns `null` when no root contains the file or when the first existing
file cannot be read or parsed. It does not distinguish those conditions or continue
to another root after a read failure. Callers that need those distinctions must
read the file directly.

`WOFFeature`, `WOFProperties` and `ParsedWOFPlacetype` describe the records.
`pluckPlacetypeSpec` extracts identity, localized names, coordinates, population
and lifecycle fields from WOF properties. These exports live at
`@mailwoman/gazetteer/whosonfirst/placetypes/admin` and are also available from the
package root.

## Read multiple parent hierarchies

A WOF record can belong to several parent hierarchies. The two readers serve
different purposes:

| Function                        | Result                                                                     | Use                                               |
| ------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------- |
| `hierarchyAncestorsInAnyBranch` | A `Map<number, string>` of ancestor IDs to placetypes, in first-seen order | Collect every ancestry relation for an index.     |
| `agreedHierarchyAncestors`      | Ancestor IDs shared by every branch, nearest level first                   | Render only ancestors that apply to every branch. |

```ts
import { agreedHierarchyAncestors, hierarchyAncestorsInAnyBranch } from "@mailwoman/gazetteer/whosonfirst/hierarchy"

const branches = [
	{ country_id: 1, region_id: 2, county_id: 3, locality_id: 5 },
	{ country_id: 1, region_id: 2, county_id: 4, locality_id: 5 },
]

agreedHierarchyAncestors(5, branches) // [2, 1]
hierarchyAncestorsInAnyBranch(5, branches) // Map { 1 => "country", 2 => "region", 3 => "county", 4 => "county" }
```

Both readers exclude the record's own ID and non-positive or non-finite IDs.
Import hierarchy helpers from the explicit subpath shown above. The package root
does not export them.

## Build gazetteer data

The build modules live under `@mailwoman/gazetteer/tools/*`. The CLI adapters live
in `mailwoman` and expose them through `mailwoman gazetteer`.

| Command                               | Purpose                                                                                                  |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `mailwoman gazetteer repos-sync`      | Synchronize WOF source repositories.                                                                     |
| `mailwoman gazetteer build admin`     | Ingest WOF, Overture and GeoNames administrative data, enrich it, build indexes and verify the database. |
| `mailwoman gazetteer build candidate` | Build the candidate database from administrative and supplementary layers.                               |
| `mailwoman gazetteer build fts`       | Build SQLite search indexes.                                                                             |
| `mailwoman gazetteer build fst`       | Build the finite-state name index.                                                                       |
| `mailwoman gazetteer verify`          | Check a gazetteer database.                                                                              |

Use each command's `--help` for its input paths and options. Builds require the
source datasets for the selected recipe. `MAILWOMAN_DATA_ROOT` selects the data
root. Conventional WOF database paths live beneath `db/wof/`.

`mailwoman gazetteer build` runs the administrative build followed by the candidate
build using the new administrative artifact. The administrative build writes a
staging database and seals it after verification. Candidate defaults include only
supplementary database files present on the machine, so available inputs affect
the resulting coverage. Inspect the manifests when comparing builds.

Build replacement databases separately from the published artifacts. Verification,
promotion and publication are separate operations. Follow the
[release procedure](../../RELEASING.md) before replacing a deployed database.
The [layer interface](../../docs/engineering/reference/layer-interface.mdx)
defines manifests, coverage and data tiers. The
[POI runbook](../../docs/engineering/reference/poi-layer-runbook.mdx) describes
the POI build and publication procedure.

## Related packages

- [`@mailwoman/resolver`](../resolver) ranks places and resolves parsed address spans.
- [`@mailwoman/resolver-wof-sqlite`](../resolver-wof-sqlite) queries SQLite place databases in Node.js.
- [`@mailwoman/resolver-wof-wasm`](../resolver-wof-wasm) provides the browser SQLite backend.
- [`@mailwoman/codex`](../codex) supplies country reference data and conventions.

## License

The package declares `AGPL-3.0-only OR LicenseRef-Commercial`. Source datasets have
their own licenses and attribution requirements. Consult each layer's manifest
and source documentation before redistributing a built artifact.
