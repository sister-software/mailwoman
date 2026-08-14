# @mailwoman/match

**The geocode-first record matcher** — a three-stage entity resolution pipeline:
**block → score → cluster**. Resolves whether two records refer to the same
real-world entity by matching the resolved _place_ (not the address string),
then comparing names and other fields.

```ts
import { block, scorePair, cluster } from "@mailwoman/match"

// Stage 1: Block — geo-first candidate generation
const pairs = block(records, {
	keys: [defaultBlockingKeys.geoCell, defaultBlockingKeys.canonical],
})

// Stage 2: Score — Fellegi-Sunter probabilistic match
const { probability } = scorePair(recordA, recordB, { model })

// Stage 3: Cluster — connected-components resolution
const entities = cluster(records, links, { threshold: 0.5 })
```

## The three-stage pipeline

### 1. Block — geo-first candidate generation

Instead of comparing every record to every other (O(n²)), blocking generates
candidate pairs via cheap, high-recall keys:

- **Geo cell key** — a generous H3 cell (~5.5 km) so two records at the same
  place meet regardless of how their address is spelled
- **Canonical address key** — the formatter's deterministic match key
- **Exact keys** — phone, email, domain for exact-match joins

### 2. Score — Fellegi-Sunter probabilistic matching

The `scorePair` function computes a match probability using:

- **String comparators** — Jaro-Winkler similarity over names and addresses
- **Distance comparison** — great-circle distance bucketed into same-building /
  same-block / same-area / far
- **Fellegi-Sunter weight model** — agreement-level log-likelihood ratios
  (`log2(m/u)`) converted to a probability
- **Label-free EM estimation** — `m`/`u` parameters learned via
  expectation-maximization without labeled training data
- **Term frequency adjustment** — rare-value agreement (e.g., an unusual
  organization name) up-weighted; common-value agreement down-weighted
- **Learned (GBT) scorer** — optional gradient-boosted tree scorer for
  single-dataset dedup, available via `scorer` hook

### 3. Cluster — connected-components

Non-transitive pairwise links (A↔B, B↔C, but not A↔C) are resolved into
canonical entities via union-find with path compression.

## API

```ts
// Blocking — generate candidate record pairs
block(records, opts: BlockOpts): { pairs: Pair[]; droppedBlocks: BlockDrop[] }

// Scoring — pairwise Fellegi-Sunter match probability
scorePair(a: SourceRecord, b: SourceRecord, opts: ScoreOpts): ScoreResult

// Clustering — resolve pairwise links into entities
cluster(records: SourceRecord[], links: ScoredLink[], opts: ClusterOpts): Entity[]

// Distance — great-circle comparison levels
haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number
distanceComparison(distKm: number): ComparisonLevel

// Learned scorer — GBT for single-dataset dedup
trainGBT(pairs: TrainingPair[], opts?: GBTOpts): GBTModel
gbtPredict(model: GBTModel, features: number[]): number

// Label-free EM parameter estimation
estimateParameters(pairs: Pair[]): EMResult

// Term frequency adjustment
withTermFrequency(model: FSModel, records: SourceRecord[]): FSModel
```

## Related

- [`@mailwoman/record`](../record) — record schemas and normalizers consumed by the matcher
- [`@mailwoman/formatter`](../formatter) — `canonicalKey` used for blocking
- [`@mailwoman/address-id`](../address-id) — complementary exact-match join key
- [`@mailwoman/registry`](../registry) — high-level `resolveEntities` that composes this pipeline
- [Geocode-First Record Matching](https://mailwoman.sister.software/articles/concepts/geocode-first-record-matching/)
- [Dedup Entity Truth](https://mailwoman.sister.software/articles/concepts/dedup-entity-truth/)
- [Spatial Expectation & Density](https://mailwoman.sister.software/articles/concepts/spatial-expectation-and-density/)

## License

[AGPL-3.0-only](https://www.gnu.org/licenses/agpl-3.0.html)
