/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The resolve pipeline — the whole matcher, wired over concrete contact/organization records: block
 *   (geo-first) → score (Fellegi-Sunter) → cluster → canonical entities.
 *
 *   `resolveEntities` ships sensible geocode-first defaults — block on location / canonical key /
 *   phone / email; score on name, organization, address key, and great-circle distance — and can
 *   fit the scorer's `m`/`u` to the data with EM (`trainEM`), so it runs with no labels and no
 *   per-dataset tuning. Everything is overridable: pass your own model, blocking keys, or
 *   threshold.
 *
 *   Geocoding is assumed already done upstream (each `address` carries its coordinate + canonical
 *   key). Wiring mailwoman's parser + geocoder to turn raw rows into `SourceRecord`s is the ingest
 *   layer that sits in front of this.
 */

import type { ComparisonLevel } from "@mailwoman/match"
import {
	type BlockingKey,
	type FellegiSunterModel,
	type ScoredLink,
	type TermFrequencyTable,
	DEFAULT_DISTANCE_LEVELS,
	agreementPattern,
	block,
	cluster,
	distanceComparison,
	estimateParameters,
	exactKey,
	geoCellKey,
	representative,
	scorePair,
	similarityComparison,
	withTermFrequency,
} from "@mailwoman/match"
import type { ResolvedEntity, SourceRecord } from "./types.js"

/**
 * Cheap, parse-free normalization for the address-frequency key — uppercase, collapse whitespace,
 * drop punctuation. Used to count how many distinct entities share an address across the WHOLE
 * corpus (computable over millions of rows without geocoding) and to look that frequency up at
 * match time. It's the inverse-frequency signal: a crowded clinic/billing address is weak evidence
 * of identity; a lonely address is strong. (See
 * docs/articles/evals/2026-06-15-nppes-dedup-benchmark.md.)
 */
export function addressFrequencyKey(raw: string): string {
	return raw
		.toUpperCase()
		.replace(/[^A-Z0-9]+/g, " ")
		.trim()
		.replace(/\s+/g, " ")
}

/** Default tiered levels for a name-like text field. `m`/`u` are EM-estimable seeds. */
const NAME_LEVELS: ComparisonLevel[] = [
	{ label: "exact", minSimilarity: 1.0, m: 0.8, u: 0.01 },
	{ label: "high", minSimilarity: 0.88, m: 0.15, u: 0.03 },
	{ label: "different", minSimilarity: 0, m: 0.05, u: 0.96 },
]

/**
 * The default geocode-first scoring model: name + organization + address key + great-circle
 * distance.
 *
 * Pass `addressFrequency` (a corpus-wide {@link TermFrequencyTable} over {@link addressFrequencyKey})
 * to make the address-agreement weight **inverse to how shared the address is** — the fix for the
 * co-located-distinct-entities over-merge (a building with 50 providers makes "same address" near-
 * worthless evidence). The table's `value` is the record's raw address string; the table normalizes
 * it.
 */
export function buildDefaultModel(
	opts: { addressFrequency?: TermFrequencyTable } = {}
): FellegiSunterModel<SourceRecord> {
	let address = similarityComparison<SourceRecord>({
		name: "address",
		extract: (r) => r.address?.canonicalKey,
		levels: NAME_LEVELS,
	})
	if (opts.addressFrequency) {
		address = withTermFrequency(address, { table: opts.addressFrequency, value: (a) => a.address?.raw ?? null })
	}
	return {
		lambda: 0.0001,
		comparisons: [
			similarityComparison({ name: "given", extract: (r) => r.name?.given, levels: NAME_LEVELS }),
			similarityComparison({ name: "family", extract: (r) => r.name?.family, levels: NAME_LEVELS }),
			similarityComparison({ name: "organization", extract: (r) => r.organization?.canonical, levels: NAME_LEVELS }),
			address,
			distanceComparison({
				name: "distance",
				extract: (r) => r.address?.geocode?.coordinate,
				levels: DEFAULT_DISTANCE_LEVELS,
			}),
		],
	}
}

/** The default blocking keys: a union of location, canonical address, phone, and email. */
export function defaultBlockingKeys(): BlockingKey<SourceRecord>[] {
	return [
		geoCellKey((r) => r.address?.geocode?.coordinate),
		exactKey((r) => r.address?.canonicalKey),
		exactKey((r) => r.phone),
		exactKey((r) => r.email),
	]
}

/** Options for {@link resolveEntities}. */
export interface ResolveConfig {
	/** Scoring model. Default {@link buildDefaultModel}. */
	model?: FellegiSunterModel<SourceRecord>
	/** Blocking keys (their union). Default {@link defaultBlockingKeys}. */
	blockingKeys?: BlockingKey<SourceRecord>[]
	/** Link two records into the same entity at or above this match weight (bits). Default 0. */
	threshold?: number
	/** Skip and report blocks larger than this rather than scanning them. */
	maxBlockSize?: number
	/**
	 * Fit the model's `m`/`u` to the candidate pairs with EM before scoring (label-free). Default
	 * false.
	 */
	trainEM?: boolean
	/**
	 * Corpus-wide address-frequency table (over {@link addressFrequencyKey}) — when set, the default
	 * model down-weights address agreement by how shared the address is. Ignored if `model` is
	 * supplied.
	 */
	addressFrequency?: TermFrequencyTable
}

/** The outcome of a resolve pass. */
export interface ResolveResult {
	entities: ResolvedEntity[]
	/** Number of candidate pairs blocking produced. */
	candidatePairs: number
	/** Blocks too large to scan, surfaced so coverage limits are visible. */
	droppedBlocks: Array<{ key: string; size: number }>
}

/**
 * Resolve source records into canonical entities: block → score → cluster. Every record lands in
 * exactly one entity (a record with no confident link is its own singleton entity).
 */
export function resolveEntities(records: readonly SourceRecord[], config: ResolveConfig = {}): ResolveResult {
	const model = config.model ?? buildDefaultModel({ addressFrequency: config.addressFrequency })
	const blockingKeys = config.blockingKeys ?? defaultBlockingKeys()
	const threshold = config.threshold ?? 0

	const { pairs, droppedBlocks } = block(records, blockingKeys, { maxBlockSize: config.maxBlockSize })

	let scoringModel = model
	if (config.trainEM && pairs.length > 0) {
		const patterns = pairs.map(([a, b]) => agreementPattern(model.comparisons, a, b))
		scoringModel = estimateParameters(model, patterns).model
	}

	const links: ScoredLink<SourceRecord>[] = pairs.map(([a, b]) => ({
		a,
		b,
		weight: scorePair(scoringModel, a, b).weight,
	}))

	const clusters = cluster(records, links, { threshold })

	const entities: ResolvedEntity[] = clusters.map((group, i) => {
		const members = new Set(group)
		const intraWeights = links
			.filter((link) => link.weight >= threshold && members.has(link.a) && members.has(link.b))
			.map((link) => link.weight)
		const rep = representative(group) ?? group[0]!

		return {
			id: `entity-${i}`,
			records: group,
			representative: rep,
			coordinate: rep.address?.geocode?.coordinate ?? undefined,
			cohesion: group.length > 1 && intraWeights.length > 0 ? Math.min(...intraWeights) : null,
		}
	})

	return { entities, candidatePairs: pairs.length, droppedBlocks }
}
