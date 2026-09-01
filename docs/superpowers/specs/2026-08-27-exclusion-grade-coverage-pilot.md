# The first exclusion-grade coverage cells — pharmacy, Île-de-France

Design record for #1964, under the coverage register design of
[`2026-08-11-coverage-register-design.md`](./2026-08-11-coverage-register-design.md) and the
`layer_coverage` contract in
[`../../engineering/reference/layer-contract.mdx`](../../engineering/reference/layer-contract.mdx).

Every one of the 158,813 coverage cells in the shipped `poi.db` carries `basis = source_present` at
`completeness = 1.0`, exactly as `build-poi.ts` writes them. `supportsExclusion` is therefore false
everywhere, and the program's rule — missing data becomes negative evidence only through
exclusion-grade coverage — has nothing to act on. This record is what it took to produce cells that
answer true, and what it deliberately did not do.

## What ships

One build-local layer database, `poi-coverage-pharmacy-ile-de-france.db`, holding 3,308
`amenity=pharmacy` features from the Île-de-France OSM extract, with 290 res-6 `layer_coverage` rows
at `basis = surveyed`, `completeness = 0.6665`. The shipped `poi.db` is not touched: it is sealed
0444, and nothing here reopens it.

## Why a separate artifact and not a rebuild

A `layer_coverage` row describes the layer it lives in — `observed_rows` is defined as "rows this
layer actually holds in the cell". Coverage about one layer's rows cannot honestly be written into a
different layer's table. That settles the artifact shape on its own:

- Writing exclusion cells into `poi.db` would mean rebuilding the shipped artifact, which the pilot
  scope excludes and the sealed-artifact rule forbids patching.
- Writing coverage cells that describe `poi.db`'s Overture rows into a new database would make
  `observed_rows` a claim about somebody else's rows.

So the pilot builds a complete layer of its own — manifest, domain rows, coverage — and its coverage
describes its own rows. That is the shape the contract already supports; no schema change was needed
to reach an exclusion-grade basis, only a builder willing to write one.

## The completeness basis

**Two-source capture-recapture between two independently-built inventories of one class in one
bounded region.** Named data on both sides, with provenance:

| role      | source                                                                       | vintage      | licence             |
| --------- | ---------------------------------------------------------------------------- | ------------ | ------------------- |
| subject   | OpenStreetMap, Geofabrik `ile-de-france-260627.osm.pbf`, `amenity=pharmacy`  | 2026-06-27   | ODbL-1.0            |
| reference | Overture Places via the shipped `poi.db`, category `pharmacy`                | 2026-07-22.0 | CDLA-Permissive-2.0 |
| region    | OSM relation 8649, `boundary=administrative`, `admin_level=4`, Île-de-France | 2026-06-27   | ODbL-1.0            |

The two inventories are independently built, and the licences are the evidence: Overture Places is
CDLA-Permissive-2.0, which it could not be if OSM were in its lineage. The class correspondence is
not improvised either — `@mailwoman/poi-taxonomy` already declares `pharmacy` with
`osmTag: "amenity=pharmacy"`, so both sides are selected by one shipped declaration rather than by
two hand-written predicates.

### Region definition

The region is **the union of res-6 H3 cells lying wholly inside the Île-de-France outline**, and both
inventories are clipped to exactly that cell set. A cell is interior when its whole `gridDisk(cell, 1)`
is in the region's own polyfill AND all six of its boundary vertices are inside the outline. The
polyfill keeps a cell whose centre is inside, so its edge ring is half outside the region; the vertex
test catches a boundary that re-enters between two neighbours. Measured: 371 polyfilled cells, 290
interior.

A bounding rectangle would have been simpler and wrong — it claims survey over every corner the
outline does not reach, and Île-de-France is not a rectangle.

### Arithmetic

Counts are after clipping to the 290 interior cells. `n1` is the reference (Overture), `n2` the
subject (OSM), `m` their one-to-one agreement. Chapman's bias-corrected estimator, with the 95%
interval from its variance:

```
N̂  = (n1+1)(n2+1)/(m+1) − 1
Var = (n1+1)(n2+1)(n1−m)(n2−m) / ((m+1)²(m+2))
completeness(subject) = n2 / N̂      recorded value = n2 / (N̂ + 1.96·√Var)
```

n1 = 1,460 · n2 = 3,248

| protocol | m     | N̂       | 95% interval      | completeness | lower bound |
| -------- | ----- | ------- | ----------------- | ------------ | ----------- |
| strict   | 1,001 | 4,736.3 | 4,599.7 – 4,873.0 | 0.6858       | **0.6665**  |
| primary  | 1,173 | 4,042.3 | 3,960.4 – 4,124.1 | 0.8035       | 0.7876      |
| loose    | 1,250 | 3,793.4 | 3,730.9 – 3,855.9 | 0.8562       | 0.8423      |

The recorded value is **0.6665** — the weakest lower bound the grid supports. Taking the minimum
rather than a chosen protocol's value keeps the threshold choice out of the claim: each protocol is a
defensible reading of "the same pharmacy", so the claim is only as strong as the weakest of them.

### The match protocol

A candidate pair clears a NEAR band, or a FAR band, or — when either row is unnamed — a distance
alone. Names are compared with `@mailwoman/codex`'s `foldName` and `@mailwoman/match`'s
`nameSimilarity`; distance is haversine metres. Assignment is one-to-one and greedy, best pair first,
so one row cannot answer for three.

| protocol | near              | far               | unnamed |
| -------- | ----------------- | ----------------- | ------- |
| strict   | ≤ 25 m, s ≥ 0.85  | ≤ 25 m, s ≥ 0.85  | ≤ 25 m  |
| primary  | ≤ 50 m, s ≥ 0.70  | ≤ 150 m, s ≥ 0.90 | ≤ 25 m  |
| loose    | ≤ 100 m, s ≥ 0.55 | ≤ 250 m, s ≥ 0.85 | ≤ 50 m  |

The grid was fixed before any completeness value was read off it. The bands come from the
nearest-neighbour distance distribution, which is strongly bimodal: over OSM rows with any Overture
row nearby, p25 = 8 m and p50 = 133 m. True co-locations sit under ~25 m; past ~150 m the near row is
a different pharmacy.

### Uniform completeness across the region, and the measurement that licenses it

One estimate covers all 290 cells. Per-cell capture-recapture is not available at this sample size —
290 cells over 3,248 subject rows is ~11 rows a cell — so a per-cell number would be noise dressed as
precision.

Applying a regional number uniformly is only honest if the region is not a mixture, so that was
measured rather than assumed, stratifying on an external variable neither inventory can influence:
the eight départements. Summing the per-stratum Chapman estimates against the pooled one:

| protocol | pooled N̂ | Σ per-département N̂ | difference |
| -------- | -------- | ------------------- | ---------- |
| strict   | 4,736.3  | 4,767.2             | +0.65%     |
| primary  | 4,042.3  | 4,055.4             | +0.32%     |
| loose    | 3,793.4  | 3,800.6             | +0.19%     |

Under 0.7% at every point of the grid. That licenses the uniform value **here**, and is not a result
that transfers to another region unmeasured.

## The meaning-of-zero rule

- 88 of the 290 cells hold **zero** subject rows and are written anyway, at
  `basis = surveyed, observed_rows = 0`. That row is the storable form of "surveyed, and there is no
  pharmacy here" — the exclusion payload, and the reason the pilot exists.
- Cells outside the region get **no row at all**. Not completeness 0: the measurement says nothing
  about the region's outside, and a missing row is the contract's word for unknown.
- 60 subject rows and 138 reference rows fell outside the interior cell set. They are counted and
  reported, not silently dropped.
- The shipped `poi.db` is unchanged — 158,813 cells, all `source_present`, `supportsExclusion` false,
  file mtime and size as they were.

## What this basis does NOT establish

Two-source capture-recapture bounds **sampling error only**. It cannot see **dependence between the
sources**: if a pharmacy is more likely to be in both inventories than chance would have it — a chain
branch on a high street against a single officine on a village lane — then `m` runs high, `N̂` runs
low, and completeness runs **high**. That is the direction that turns a data gap into confident
negative evidence, which is the worst failure this system has. The conservative reading (a lower
confidence bound, minimised across the grid) controls the sampling half and does nothing about this
half.

Two smaller limits, both measured rather than argued:

- **Class tail.** 8 features in the extract carry `healthcare=pharmacy` without `amenity=pharmacy`
  (0.24% of 3,308). The taxonomy's declared predicate is `amenity=pharmacy` and that is what both
  sides use. `shop=chemist` (83 features — a parapharmacie, not an officine) is correctly outside the
  class on the OSM side, and Overture's sibling `drugstore` category holds 0 rows in the region, so
  the class boundary agrees on both sides.
- **Cell assignment at the boundary.** A row's coverage cell is `cellToParent` of its res-9 cell,
  matching every existing reader; a direct res-6 `latLngToCell` disagrees for a real fraction of
  points and would move an observed count off the cell it was observed in.

## What breadth requires

Not a wider run of this command. Either:

1. **A third independent inventory**, which makes the dependence between any two of them estimable
   rather than assumed; or
2. **An authoritative register** — for French pharmacies the Ordre national des pharmaciens' roll is
   the obvious candidate, and would license `basis = designated` rather than `surveyed`. A register we
   cannot obtain is not a basis, which is why it is not this one.

Until one of those lands, more region-class pairs multiply an unquantified bias rather than extending
a measurement. The command is parameterized so the claim can be **re-run and audited** — falsifier 7
of the coverage-register record, "sample N cells claimed complete, reconcile against a second source" —
not so coverage can be widened by pointing it somewhere else.

## Distribution

`tier: build-local`, `license: ODbL-1.0`, attribution to OpenStreetMap contributors. The subject
inventory is OSM, so the built artifact is a Derived Database: we ship the builder and the user builds
on their own disk. It is not published and not in the data-bundles registry.

## Where the code is

| piece                                                                  | what it owns                                                     |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `packages/mailwoman/lib/commands/gazetteer/build/poi-coverage.tsx`     | the command — the one path in this pipeline to `basis: surveyed` |
| `packages/mailwoman/lib/gazetteer-pipeline/poi/capture-recapture.ts`   | the match protocol grid and Chapman's estimator, pure            |
| `packages/mailwoman/lib/gazetteer-pipeline/poi/coverage-region.ts`     | region outline → interior cell set, pure                         |
| `packages/mailwoman/lib/gazetteer-pipeline/poi/exclusion-coverage.ts`  | composition into coverage cells, pure                            |
| `packages/mailwoman/lib/gazetteer-pipeline/poi/reference-inventory.ts` | the read-only probe of a sealed reference layer                  |
| `packages/osm/lib/sdk/extract-boundary.ts`                             | the named administrative outline, refusing a multi-match         |
| `packages/core/lib/layers/manifest.ts`                                 | coverage-cell invariants, now enforced at write AND read         |

To rebuild it:

```bash
mw gazetteer build poi-coverage \
  --pbf "$MAILWOMAN_DATA_ROOT/osm/geofabrik/ile-de-france-260627.osm.pbf" \
  --region "Île-de-France" --admin-level 4 --category pharmacy \
  --country FR --release 260627
```

## A defect this work found

The OSM extractor read every tag through `hstore_get_value(other_tags, …)` unless the key was in a
single layer-agnostic promoted set of `name` and `man_made`. GDAL's default `osmconf.ini` promotes a
**different** key list per layer, and a promoted key is removed from that layer's `other_tags`.
`amenity` is promoted on `multipolygons` and not on `points`, so the hstore expression answered **0**
on `multipolygons` where the bare column answered **178**, against 3,130 from `points` — 5.4% of the
class reported as absent, with no error, in the direction that inflates a completeness estimate. The
promoted-key table is now per-layer, and an unknown layer throws rather than producing SQL that runs
and matches nothing.
