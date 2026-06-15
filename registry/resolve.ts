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
	DEFAULT_SPATIAL_LEVELS,
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
	spatialComparison,
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
 * Exact-vs-different levels for a normalized phone. A shared line is strong, rarely-coincidental
 * evidence.
 */
const PHONE_LEVELS: ComparisonLevel[] = [
	{ label: "exact", minSimilarity: 1.0, m: 0.6, u: 0.002 },
	{ label: "different", minSimilarity: 0, m: 0.4, u: 0.998 },
]

/** Last-10-digits normalization for phone agreement (drops country code, punctuation, extensions). */
function normalizePhone(raw: string | null | undefined): string | null {
	if (!raw) return null
	const digits = raw.replace(/\D+/g, "")
	return digits.length >= 10 ? digits.slice(-10) : digits || null
}

/**
 * The identity-corroborating comparisons (person name, organization, phone). A2 (#625,
 * {@link ResolveConfig.requireCorroboration}) requires at least one of these to _positively_ agree
 * before a pair may link — a shared address alone is not identity. Phone (A3) is the secondary
 * identifier that rescues a true same-entity link across name drift.
 */
const CORROBORATING_FIELDS = new Set(["given", "family", "organization", "phone"])

/**
 * Options for {@link buildDefaultModel}. Each lever is default-off, so the base model is
 * byte-stable.
 */
export interface DefaultModelOptions {
	/**
	 * Corpus-wide address-frequency table (over {@link addressFrequencyKey}) — makes the address-
	 * agreement weight **inverse to how shared the address is** (a building with 50 providers makes
	 * "same address" near-worthless evidence). The table's `value` is the record's raw address
	 * string.
	 */
	addressFrequency?: TermFrequencyTable
	/**
	 * **A1 (#625):** collapse the redundant address-key + great-circle-distance comparisons into ONE
	 * {@link spatialComparison spatial-agreement} signal — an exact-key tier (where
	 * `addressFrequency`, if set, rides) over distance buckets. Removes the double-count that
	 * over-merges co-located providers (an exact key match already implies distance ≈ 0).
	 */
	collapseSpatial?: boolean
	/**
	 * **A3 (#625):** add a normalized-phone exact-match comparison — a shared line is strong evidence
	 * and the secondary corroborator that lets a true same-entity link survive name drift under A2.
	 */
	usePhone?: boolean
	/**
	 * Extra secondary-identifier comparisons drawn from {@link SourceRecord.attributes} (e.g.
	 * `["authorizedOfficial"]`). Each becomes an `attr:<key>` comparison AND counts toward A2
	 * corroboration — a more reliable discriminator than phone where the data has one (#625).
	 */
	discriminators?: string[]
}

/**
 * The default geocode-first scoring model: name + organization + a spatial signal. The spatial
 * signal is either two comparisons (address-key similarity + great-circle distance — the legacy
 * default, which double-counts) or, with {@link DefaultModelOptions.collapseSpatial}, one collapsed
 * {@link spatialComparison}. `addressFrequency` down-weights agreement on a crowded address either
 * way.
 */
export function buildDefaultModel(opts: DefaultModelOptions = {}): FellegiSunterModel<SourceRecord> {
	const identity = [
		similarityComparison<SourceRecord>({ name: "given", extract: (r) => r.name?.given, levels: NAME_LEVELS }),
		similarityComparison<SourceRecord>({ name: "family", extract: (r) => r.name?.family, levels: NAME_LEVELS }),
		similarityComparison<SourceRecord>({
			name: "organization",
			extract: (r) => r.organization?.canonical,
			levels: NAME_LEVELS,
		}),
	]
	if (opts.usePhone) {
		identity.push(
			similarityComparison<SourceRecord>({
				name: "phone",
				extract: (r) => normalizePhone(r.phone),
				similarity: (a, b) => (a === b ? 1 : 0), // exact normalized-digit match only
				levels: PHONE_LEVELS,
			})
		)
	}
	for (const key of opts.discriminators ?? []) {
		identity.push(
			similarityComparison<SourceRecord>({
				name: `attr:${key}`,
				extract: (r) => r.attributes?.[key],
				levels: NAME_LEVELS,
			})
		)
	}

	if (opts.collapseSpatial) {
		let spatial = spatialComparison<SourceRecord>({
			name: "spatial",
			key: (r) => r.address?.canonicalKey,
			coordinate: (r) => r.address?.geocode?.coordinate,
			levels: DEFAULT_SPATIAL_LEVELS,
		})
		if (opts.addressFrequency) {
			spatial = withTermFrequency(spatial, {
				table: opts.addressFrequency,
				value: (a) => a.address?.raw ?? null,
				levels: [0], // the exact same-key tier
			})
		}
		return { lambda: 0.0001, comparisons: [...identity, spatial] }
	}

	// Legacy two-signal spatial: address-key similarity + great-circle distance (redundant; A1 collapses it).
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
			...identity,
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
	/**
	 * A1 (#625): build the default model with one collapsed {@link spatialComparison} instead of the
	 * redundant address-key + distance pair. Ignored if `model` is supplied.
	 */
	collapseSpatial?: boolean
	/**
	 * A2 (#625): require positive name OR org corroboration ({@link CORROBORATING_FIELDS}) for a link
	 * — a shared address alone cannot merge two records. Suppresses the spatial-only links that fuse
	 * distinct co-located providers. Default false.
	 */
	requireCorroboration?: boolean
	/**
	 * A3 (#625): add a normalized-phone comparison to the default model — strong evidence and the
	 * secondary corroborator that keeps A2 from killing name-drift recall. Ignored if `model` is
	 * supplied.
	 */
	usePhone?: boolean
	/**
	 * A4 (#625): clustering linkage. `"single"` (default) = connected components; `"average"` =
	 * average-linkage refinement that splits a component whose sub-clusters are joined only by a weak
	 * bridge — the principled over-merge fix.
	 */
	linkage?: "single" | "average"
	/**
	 * Extra secondary-identifier keys (from {@link SourceRecord.attributes}) to add as comparisons +
	 * corroborators — e.g. `["authorizedOfficial"]`. Ignored if `model` is supplied.
	 */
	discriminators?: string[]
	/**
	 * Override the Fellegi-Sunter link weight with a LEARNED score (#603). When set, a candidate
	 * pair's match weight is this function's return value (same threshold-comparable units as the FS
	 * weight) instead of {@link scorePair}'s. Default undefined (pure FS). The blocking + clustering
	 * are unchanged, so a trained scorer can be A/B'd against the FS spine on the identical pipeline.
	 * The function is responsible for its own feature computation (e.g. the agreement pattern, which
	 * is EM-independent, plus any corpus statistics it captured).
	 *
	 * INTERACTION with {@link requireCorroboration}: the two are independent and compose, but the
	 * corroboration gate is still evaluated on the Fellegi-Sunter `contributions` (NOT the learned
	 * score) — so a learned-high pair with no positive FS name/org/phone agreement is still gated
	 * out. A learned scorer is normally trained to subsume corroboration, so use ONE or the other;
	 * combining them lets the FS gate veto the learned score, which is rarely what you want.
	 */
	scorer?: (a: SourceRecord, b: SourceRecord) => number
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
	const model =
		config.model ??
		buildDefaultModel({
			addressFrequency: config.addressFrequency,
			collapseSpatial: config.collapseSpatial,
			usePhone: config.usePhone,
			discriminators: config.discriminators,
		})
	const blockingKeys = config.blockingKeys ?? defaultBlockingKeys()
	const threshold = config.threshold ?? 0

	const { pairs, droppedBlocks } = block(records, blockingKeys, { maxBlockSize: config.maxBlockSize })

	let scoringModel = model
	if (config.trainEM && pairs.length > 0) {
		const patterns = pairs.map(([a, b]) => agreementPattern(model.comparisons, a, b))
		scoringModel = estimateParameters(model, patterns).model
	}

	const links: ScoredLink<SourceRecord>[] = pairs.map(([a, b]) => {
		const score = scorePair(scoringModel, a, b)
		// #603: a learned scorer replaces the FS weight (same clustering + threshold semantics).
		let weight = config.scorer ? config.scorer(a, b) : score.weight
		// A2 (#625): a link must carry positive name OR org corroboration — a shared (even down-weighted)
		// address alone is not identity. Spatial-only pairs are suppressed below any threshold.
		if (config.requireCorroboration) {
			const corroborated = score.contributions.some(
				(c) => (CORROBORATING_FIELDS.has(c.name) || c.name.startsWith("attr:")) && c.weight > 0
			)
			if (!corroborated) weight = Number.NEGATIVE_INFINITY
		}
		return { a, b, weight }
	})

	const clusters = cluster(records, links, { threshold, linkage: config.linkage })

	// Cohesion = the weakest within-cluster link weight (how tightly an entity holds together). Compute it
	// in ONE pass over links via a record→cluster index, not by filtering every link for every cluster —
	// the latter is O(clusters × links) and dominates the resolve at scale.
	const clusterOf = new Map<SourceRecord, number>()
	clusters.forEach((group, i) => {
		for (const record of group) clusterOf.set(record, i)
	})
	const minIntraWeight = new Array<number>(clusters.length).fill(Infinity)
	for (const link of links) {
		if (link.weight < threshold) continue
		const ci = clusterOf.get(link.a)
		if (ci === undefined || ci !== clusterOf.get(link.b)) continue
		if (link.weight < minIntraWeight[ci]!) minIntraWeight[ci] = link.weight
	}

	const entities: ResolvedEntity[] = clusters.map((group, i) => {
		const rep = representative(group) ?? group[0]!
		return {
			id: `entity-${i}`,
			records: group,
			representative: rep,
			coordinate: rep.address?.geocode?.coordinate ?? undefined,
			cohesion: group.length > 1 && minIntraWeight[i]! !== Infinity ? minIntraWeight[i]! : null,
		}
	})

	return { entities, candidatePairs: pairs.length, droppedBlocks }
}
