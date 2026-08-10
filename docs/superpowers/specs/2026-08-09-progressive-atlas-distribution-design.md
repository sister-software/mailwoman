# Progressive atlas distribution

**Date:** 2026-08-09  
**Status:** direction approved; implementation plan pending  
**Related:** [issue #1577](https://github.com/sister-software/mailwoman/issues/1577),
[spatial-layer contract](../../engineering/reference/layer-contract.mdx),
[WOF granularity scorecard](./2026-08-02-wof-granularity-scorecard-design.md),
[inferential resolution](../plans/2026-08-08-inferential-resolution.md)

## The questions

Mailwoman currently distributes three kinds of consumer artifact through two mechanisms. npm carries
the engine and model packages. `mailwoman data pull` downloads SQLite databases named `candidate`,
`us`, `fr`, and `poi`. The downloader is sound, but those four names mix an implementation detail, two
territories, and a semantic layer.

The knowledge graph makes that naming problem structural. We need answers to four questions before
adding more databases:

1. What is installed with the engine, the model, and the atlas?
2. How can every installation retain worldwide coverage while a consumer chooses where to buy disk
   and precision?
3. Where do country-specific address systems live when the atlas is globally partitioned?
4. How does the CLI explain, plan, fetch, verify, and diagnose the resulting installation?

This design answers those questions. It does not choose the physical H3 shard resolution, publish a
new catalog, or estimate final artifact sizes. Those require measured build prototypes.

## Decision

Mailwoman has three independently versioned planes:

```text
engine    npm code: pipeline, resolver, layer readers, CLI
grammar   shared model plus address-system/locale overlays
atlas     sealed SQLite layers selected by area, subject, and precision
```

The atlas begins with a global administrative and identity skeleton. Additional layers refine a
selected part of the world. A missing address layer therefore degrades an answer toward locality,
region, or country instead of making the area disappear from the resolver.

The consumer vocabulary is:

```text
area × detail × layer
```

Countries remain useful selectors, source-acquisition boundaries, and resolver policy scopes. They
do not dictate the physical shape of every downloaded database.

## Models and address systems stay scoped

The global atlas does not imply a universal address grammar. Component order, postcode semantics,
dependent-locality use, numbering, formatting, and omission rules vary by address system. The model
and resolver continue to carry that distinction.

The present model shape remains:

```text
shared encoder and tokenizer
        +
country/locale overlay data
        +
country-scoped resolver conventions and calibration
```

An overlay can contain reference binaries, pair indexes, calibration, and locale data without
copying the shared ONNX model. npm remains the distribution mechanism because these artifacts are
coupled to runtime versions and belong in the application's dependency lockfile.

Country is a strong address-system prior. Language is a separate observation. Multilingual
countries, exonyms, native-script venue names, and transliterated queries all require a many-to-many
relationship between country, script, locale, and address system. A future `AddressSystemID` may
make that relationship explicit; an ISO country code alone should never become a claim that the
country has one language.

The CLI diagnoses model availability and prints a package-manager command. `mailwoman data pull`
does not edit `package.json` or fetch model weights.

## Atlas depth

The installed atlas is a coverage pyramid:

| Depth       | Contents                                                                            | Finest ordinary claim            |
| ----------- | ----------------------------------------------------------------------------------- | -------------------------------- |
| global core | stable place identities, countries, regions, hierarchy, coarse geometry, prominence | country or region                |
| locality    | locality identities, primary names, coordinates/bounds, parent edges                | locality                         |
| aliases     | alternate names, exonyms, transliterations, language/script metadata                | same geometry, broader retrieval |
| postcode    | postcode geometry and locality relationships                                        | postcode region                  |
| street      | named street geometry and interpolation support                                     | street or interpolated range     |
| address     | situs/rooftop points and address relationships                                      | address point                    |
| POI         | venues, businesses, landmarks, categories, brands                                   | named place                      |
| domain      | infrastructure, BDC, parcels, hazards, private records                              | layer-specific claim             |

"Worldwide coverage" describes the surviving spatial claim. It does not promise every locality
name, postcode, street, or rooftop in the starter download. An installation with only the global
core can still bound a query to a country or region. Each additional layer narrows the candidate
space when its coverage permits that claim.

Every result continues to report `resolution_tier`, uncertainty, and provenance. Layer absence and
source absence remain different states. The `layer_coverage` contract decides whether zero means
"observed absent" or "unknown."

## Replace the monolithic candidate projection

The current `candidate.db` is a denormalized serving projection. Each alias row repeats the place
name, coordinates, bounding box, population, placetype, country, and WOF ID so the reader can answer
with one clustered probe. That is useful for HTTP byte-range access and expensive as a general local
distribution format.

The progressive atlas separates lookup keys from entity facts:

```text
name_key → entity_id
entity_id → names, coordinate, bbox, parents, prominence, provenance
```

The first build prototype should produce at least these projections:

```text
atlas-core.db             global identity + country/region graph
atlas-locality.db         primary/local locality names + locality facts
atlas-aliases-basic.db    reviewed native/English exonyms and common transliterations
```

Further alias packs may be selected by language or script. WOF already supplies multilingual names;
the build must preserve their language and name-kind metadata instead of flattening them into an
untyped string pile.

Local Node serving can afford a lookup followed by an entity probe. The browser may continue to use
a denormalized, byte-range-optimized projection built from the same graph. We should measure both
before making one schema serve incompatible access patterns.

The size of the starter atlas is an output of this prototype. The design expects normalization and
alias separation to reduce it materially from the current approximately 1.65 GB candidate database,
but sets no byte target before a real build and lookup benchmark.

## Starter profile

The ten-minute path remains short:

```bash
npm install mailwoman @mailwoman/neural @mailwoman/neural-weights-en-us
npx mailwoman doctor
npx mailwoman parse "350 5th Ave, New York, NY 10118"
npx mw data pull starter
npx mw geocode "12 Rue de Rivoli, 75001 Paris"
```

`starter` expands to a catalog-pinned set rather than a second artifact format:

```text
global core
global locality layer
basic multilingual aliases
```

Postcodes may join the starter profile only after the prototype measures their worldwide coverage,
size, and fallback value. Address, street, POI, and domain layers remain optional.

The guide promises worldwide country/region/locality resolution at the depth supported by those
layers. It then shows one explicit refinement:

```bash
npx mw data plan --area gb --detail address
npx mw data pull --area gb --detail address
```

Profiles provide progressive disclosure. `starter`, `standard`, `local`, and `complete` are named
catalog queries, not frozen bundles with bespoke loaders.

## Area selection and physical shards

The public CLI accepts several area selectors:

```text
ISO country or subdivision
bbox
center + radius
H3 cell
named administrative entity after the global core is installed
```

The catalog expands an area selector into immutable spatial artifacts. A fixed coarse global grid is
the leading physical layout because every spatial layer already declares an H3 spine. The exact
resolution remains a prototype decision: dense cities and sparse rural regions need measured shard
size and open-file behavior before we freeze it.

A country request remains pleasant:

```bash
mw data pull --area nz --detail address
```

Internally it selects the intersecting address artifacts. A border query may select cells from two
countries without inventing a special cross-border database.

The build assigns an entity to one canonical home shard and records cross-shard references by stable
ID. Geometry that crosses shard boundaries needs an explicit fragmentation or indirection rule; the
prototype must prove that rule before publication.

SQLite's attachment limit rules out attaching a planet of tiny files. The runtime needs a shard
broker that:

1. maps the query or candidate region to artifact IDs;
2. opens only the relevant databases;
3. keeps a bounded connection cache;
4. queries the finest eligible layer;
5. falls through to the next installed depth when coverage or retrieval does not support the claim.

## Catalog and embedded manifests

The remote catalog answers what can be installed. Each SQLite database's embedded layer manifest
answers what is actually installed. Both are required.

```ts
interface AtlasArtifact {
	id: string
	layer: string
	detail: "global" | "regional" | "local"
	coverageCells: string[]
	remotePath: string
	localPath: string
	bytes: number
	sha256: string
	dependencies: string[]
	license: string
	sourceVintage: string
	schemaVersion: number
}
```

`localPath` is a POSIX-style path relative to the resolved data root. Catalog validation rejects an
absolute path, an empty segment, and any `..` traversal. One shared resolver converts catalog paths
to host paths. Builders, downloaders, `doctor`, and runtime readers use that resolver rather than
reconstructing nested relative paths independently.

Catalog releases are immutable and content-addressed. Installation writes a local receipt only after
every artifact is downloaded, hashed, sealed, and atomically moved. A failed multi-artifact pull
leaves the prior installation usable.

Dependencies are explicit. An address shard may depend on a global identity version and a street
schema version without requiring every other address shard from the same country.

## CLI contract from issue #1577

Issue #1577 supplies the consumer acceptance surface for this design:

```bash
mw data list
mw data list --installed
mw data list --area gb
mw data list --layer address
mw data plan --area gb --detail address
mw data pull starter
mw data status
mw data prune
mw doctor --verbose
```

`data plan` performs no writes and prints:

- the resolved profile and catalog version;
- artifacts and dependencies;
- download and installed bytes;
- geographic and semantic coverage;
- source vintages, licenses, and attribution;
- the data root and registry host.

`data pull --host` selects a compatible mirror or private registry. The host can also live in the
Mailwoman config file. Enterprise and air-gapped installations use the same catalog schema as the
public registry.

`doctor` orders runtime checks before optional data. Each missing layer names the consequence and
the smallest command that changes it. Verbose mode prints resolved model packages, address-system
profiles, data/config/cache paths, registries, installed catalog receipts, layers, vintages, and
coverage.

The `mw` alias and `man mailwoman` are packaging/documentation work around the same commands; they do
not introduce alternate behavior.

## Filesystem contract

`env-paths` supplies platform-native defaults. Existing deployments retain
`MAILWOMAN_DATA_ROOT` as the complete durable-data override.

```text
data/
  catalogs/
  receipts/
  atlas/
    core/
    locality/
    aliases/
    postcode/
    street/
    address/
    poi/
    layers/
  private/

cache/
  downloads/
  catalogs/

config/
  config.json
  registries.json
```

Temporary transfer state belongs in the cache path. Sealed databases and installation receipts
belong in the data path. Registry configuration belongs in the config path. The `$public` env schema
owns the typed overrides, and a repository lint prevents new call sites from inventing their own
Mailwoman directories.

## Licensing tiers keep the same runtime shape

The layer contract's three tiers remain:

- `shipped`: permissive/public-domain artifacts distributed by Mailwoman;
- `build-local`: ODbL or other restricted inputs built on the consumer's machine;
- `private`: customer and internal layers that never leave their environment.

All three register through the same local catalog and shard broker. A country may combine BAN,
OpenAddresses, OSM, and private address facts while provenance remains attached to each row and
artifact. The resolver's precedence policy must preserve those sources rather than flattening them
into an unexplained winner.

## Compatibility and migration

The existing commands remain valid through at least one migration window:

```text
data pull candidate  → starter-compatible global projections
data pull us         → area=us, detail=address plus interpolation
data pull fr         → area=fr, detail=address
data pull poi        → layer=poi at its published coverage
```

The old conventional paths continue to resolve while the shard broker lands. `doctor --verbose`
reports legacy artifacts and the equivalent catalog request. Migration never rewrites or deletes a
legacy database automatically; `data prune` requires an explicit selection and prints what becomes
unavailable.

## Prototype gates

No distribution migration begins until a prototype answers these with receipts:

1. Size by projection: global core, locality facts, primary names, basic aliases, full aliases.
2. Lookup quality against the current `candidate.db`, stratified by country, placetype, script, and
   primary-name versus alias query.
3. Node lookup latency, cold-open cost, and bounded-cache behavior across realistic shard counts.
4. Browser byte-range behavior for normalized and denormalized projections.
5. Cross-border queries and cross-shard graph edges.
6. Fallback correctness when locality, postcode, street, or address layers are absent.
7. Path portability on Linux, macOS, Windows, containers, and a custom `MAILWOMAN_DATA_ROOT`.
8. Catalog tamper, traversal, partial-download, stale-version, and dependency-failure tests.
9. License and attribution aggregation for a mixed shipped/build-local/private installation.
10. Zero regressions against the current ten-minute trial's US and French geocodes.

## Sequence

1. Build a read-only projection census from the current WOF/candidate inputs. Measure the size tied
   to entity facts, primary names, aliases, bounding boxes, and side indexes.
2. Produce normalized global-core and locality prototypes beside the current candidate artifact.
3. Add a catalog schema and `data plan`; keep `data pull` on the current registry during this step.
4. Implement path resolution and env-path defaults from issue #1577.
5. Build the shard broker over a small two-region address pilot, including a border case.
6. Re-run candidate parity, the geocoder panel, and cold-start documentation tests.
7. Publish `starter` as an opt-in profile. Preserve the current candidate path as default until the
   acceptance battery clears.
8. Move the ten-minute guide after the profile is available from the public host and verified from a
   clean consumer project.

The architecture can grow one layer at a time. The first implementation increment is the census and
catalog plan, because both are read-only and tell us whether the proposed starter is actually small
before we ask consumers to depend on it.
