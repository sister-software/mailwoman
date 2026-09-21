/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The resolve pipeline — the whole matcher, wired over concrete contact/organization records: block
 *   (geo-first) → score (Fellegi-Sunter) → cluster → canonical entities.
 *
 *   `resolveEntities` ships sensible geocode-first defaults — block on location / canonical key /
 *   phone / email. score on name, organization, address key, and great-circle distance — and can
 *   fit the scorer's `m`/`u` to the data with EM (`trainEM`), so it runs with no labels and no
 *   per-dataset tuning. Everything is overridable: pass your own model, blocking keys, or
 *   threshold.
 *
 *   Geocoding is assumed already done upstream (each `address` carries its coordinate + canonical
 *   key). Wiring mailwoman's parser + geocoder to turn raw rows into `SourceRecord`s is the ingest
 *   layer that sits in front of this.
 */

import {
	type ComparisonLevel,
	type BlockingKey,
	type FellegiSunterModel,
	type GBT,
	type ScoredLink,
	type TermFrequencyTable,
	DEFAULT_DISTANCE_LEVELS,
	DEFAULT_SPATIAL_LEVELS,
	agreementPattern,
	block,
	buildTermFrequencyTable,
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

import { createGBTScorer } from "#learned-scorer"
import { DEDUP_GBT_META, DEDUP_GBT_MODEL } from "#models/dedup-gbt-en-us"
import type { ResolvedEntity, SourceRecord } from "#types"

/**
 * Cheap, parse-free normalization for the address-frequency key — uppercase,
 * collapse whitespace, drop punctuation.
 *
 * Used to count how many distinct entities share an address across the whole corpus
 * (computable over millions of rows without geocoding) and to look that frequency up at match time.
 * It's the inverse-frequency signal: a crowded clinic/billing address is weak evidence of identity.
 * A lonely address is strong.
 *
 * (See docs/articles/evals/matcher-dedup/2026-06-15-nppes-dedup-benchmark.md.)
 */
export function addressFrequencyKey(raw: string): string {
	return raw
		.toUpperCase()
		.replaceAll(/[^A-Z0-9]+/g, " ")
		.trim()
		.replaceAll(/\s+/g, " ")
}

/**
 * Default tiered levels for a name-like text field.
 *
 * `m`/`u` are EM-estimable seeds.
 */
const NAME_LEVELS: ComparisonLevel[] = [
	{ label: "exact", minSimilarity: 1, m: 0.8, u: 0.01 },
	{ label: "high", minSimilarity: 0.88, m: 0.15, u: 0.03 },
	{ label: "different", minSimilarity: 0, m: 0.05, u: 0.96 },
]

/**
 * Exact-vs-different levels for a normalized phone.
 *
 * A shared line is strong, rarely-coincidental evidence.
 */
const PHONE_LEVELS: ComparisonLevel[] = [
	{ label: "exact", minSimilarity: 1, m: 0.6, u: 0.002 },
	{ label: "different", minSimilarity: 0, m: 0.4, u: 0.998 },
]

/**
 * Exact-vs-different levels for a closed-vocabulary code SET
 * ({@link DefaultModelOptions.exactDiscriminators} — NPPES taxonomy codes, license numbers).
 *
 * Seeds only — EM refits.
 * `u` starts well above phone's 0.002: two random providers share a specialty far more
 * often than a phone line (dermatologists cluster in dermatology buildings).
 */
const CODE_SET_LEVELS: ComparisonLevel[] = [
	{ label: "exact", minSimilarity: 1, m: 0.75, u: 0.08 },
	{ label: "different", minSimilarity: 0, m: 0.25, u: 0.92 },
]

/**
 * 1 when the whitespace-joined code sets share any code, else 0 (order/count-insensitive, case-folded).
 */
function codeSetOverlap(a: string, b: string): number {
	const sa = new Set(
		a
			.toUpperCase()
			.split(/\s+/)
			.filter((value) => value.length)
	)

	for (const t of b.toUpperCase().split(/\s+/)) if (t && sa.has(t)) return 1

	return 0
}

/**
 * Last-10-digits normalization for phone agreement (drops country code, punctuation, extensions).
 *
 * A shorter digit string is kept as-is — partial agreement still carries weight in
 * the comparison model; `null` means no digits at all.
 */
export function normalizePhone(raw: string | null | undefined): string | null {
	if (!raw) return null
	const digits = raw.replaceAll(/\D+/g, "")

	return digits.length >= 10 ? digits.slice(-10) : digits || null
}

/**
 * {@link normalizePhone} under the probes' stricter interface: only a full line counts.
 *
 * The last 10 digits when the input carries at least 10, `""` otherwise (never a partial digit string).
 *
 * Callers guard on truthiness, so `""` reads as "no comparable phone" rather than a weaker key.
 */
export function normalizePhoneStrict(raw: string | null | undefined): string {
	const digits = normalizePhone(raw)

	return digits && digits.length === 10 ? digits : ""
}

/**
 * The identity-corroborating comparisons (person name, organization, phone).
 *
 * A2 (#625, {@link ResolveConfig.requireCorroboration}) requires at least one of
 * these to _positively_ agree before a pair may link.
 * A shared address alone is not identity.
 *
 * Phone (A3) is the secondary identifier that rescues a true same-entity link across name drift.
 */
const CORROBORATING_FIELDS = new Set(["given", "family", "organization", "phone"])

/**
 * Options for {@link buildDefaultModel}.
 *
 * Each change is default-off, so the base model is byte-stable.
 */
export interface DefaultModelOptions {
	/**
	 * Corpus-wide address-frequency table (over {@link addressFrequencyKey}) —
	 * makes the address- agreement weight **inverse to how shared the address is**
	 * (a building with 50 providers makes "same address" near-worthless evidence).
	 *
	 * The table's `value` is the record's raw address string.
	 */
	addressFrequency?: TermFrequencyTable
	/**
	 * **A1 (#625):** collapse the redundant address-key + great-circle-distance comparisons
	 * into one {@link spatialComparison spatial-agreement} signal — an exact-key tier
	 * (where `addressFrequency`, if set, rides) over distance buckets.
	 *
	 * Removes the double-count that over-merges co-located providers
	 * (an exact key match already implies distance ≈ 0).
	 */
	collapseSpatial?: boolean
	/**
	 * **A3 (#625):** add a normalized-phone exact-match comparison.
	 *
	 * A shared line is strong evidence and the secondary corroborator that lets a
	 * true same-entity link survive name drift under A2.
	 */
	usePhone?: boolean
	/**
	 * Extra secondary-identifier comparisons drawn from {@link SourceRecord.attributes}
	 * (e.g. `["authorizedOfficial"]`).
	 *
	 * Each becomes an `attr:<key>` comparison and counts toward A2 corroboration.
	 * A more reliable discriminator than phone where the data has one (#625).
	 */
	discriminators?: string[]
	/**
	 * Closed-vocabulary code-SET discriminators drawn from
	 * {@link SourceRecord.attributes} (#625 taxonomy change).
	 *
	 * The attribute value is a whitespace-joined set of codes
	 * (NPPES taxonomy codes, license numbers, …); agreement = any shared code
	 * (set overlap rather than string similarity — `207R00000X` vs `207Q00000X` are different
	 * specialties despite near-identical text, exactly the case string similarity mis-scores).
	 * The over-merge separator: two co-located records of one entity nearly always
	 * share a code, two distinct co-located providers usually don't.
	 */
	exactDiscriminators?: string[]
}

/**
 * The default geocode-first scoring model: name + organization + a spatial signal.
 *
 * The spatial signal is either two comparisons (address-key similarity +
 * great-circle distance — the legacy default, which double-counts) or, with
 * {@link DefaultModelOptions.collapseSpatial}, one collapsed {@link spatialComparison}.
 * `addressFrequency` down-weights agreement on a crowded address either way.
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

	for (const key of opts.exactDiscriminators ?? []) {
		identity.push(
			similarityComparison<SourceRecord>({
				name: `attr:${key}`,
				extract: (r) => r.attributes?.[key],
				similarity: codeSetOverlap, // any shared code = 1, else 0 — never string similarity (see the config doc)
				levels: CODE_SET_LEVELS,
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

	// Legacy two-signal spatial: address-key similarity + great-circle distance (redundant. A1 collapses it).
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

/**
 * The default blocking keys: a union of location, canonical address, phone, and email.
 */
export function defaultBlockingKeys(): BlockingKey<SourceRecord>[] {
	return [
		geoCellKey((r) => r.address?.geocode?.coordinate),
		exactKey((r) => r.address?.canonicalKey),
		exactKey((r) => r.phone),
		exactKey((r) => r.email),
	]
}

/**
 * Options for {@link resolveEntities}.
 */
export interface ResolveConfig {
	/**
	 * Scoring model.
	 *
	 * Default {@link buildDefaultModel}.
	 */
	model?: FellegiSunterModel<SourceRecord>
	/**
	 * Blocking keys (their union).
	 *
	 * Default {@link defaultBlockingKeys}.
	 */
	blockingKeys?: BlockingKey<SourceRecord>[]
	/**
	 * Link two records into the same entity at or above this match weight (bits).
	 *
	 * Default 0.
	 */
	threshold?: number
	/**
	 * Skip and report blocks larger than this rather than scanning them.
	 */
	maxBlockSize?: number
	/**
	 * Fit the model's `m`/`u` to the candidate pairs with EM before scoring (label-free).
	 *
	 * Default false.
	 */
	trainEM?: boolean
	/**
	 * Address-frequency table (over {@link addressFrequencyKey}) — down-weights address agreement by how
	 * shared the address is (a crowded clinic/billing address is weak identity evidence). **Default-on
	 * (#625):** when omitted, `resolveEntities` auto-computes the table over the input records' addresses
	 * (the right scope for a single dataset — a crowded address within the data is down-weighted).
	 *
	 * Pass your own {@link TermFrequencyTable} (e.g. A corpus-wide one) to override,
	 * or `false` to disable (the legacy bare baseline).
	 * Ignored if `model` is supplied.
	 */
	addressFrequency?: TermFrequencyTable | false
	/**
	 * A1 (#625): collapse the redundant address-key + distance pair into one {@link spatialComparison}.
	 * **Default-on (true)** — the cleaner, less-over-merging spatial model.
	 *
	 * Set `false` for the legacy two-signal baseline.
	 * Ignored if `model` is supplied.
	 */
	collapseSpatial?: boolean
	/**
	 * A2 (#625): require positive name or org corroboration ({@link CORROBORATING_FIELDS})
	 * for a link — a shared address alone cannot merge two records.
	 *
	 * Suppresses the spatial-only links that fuse distinct co-located providers.
	 * Default false.
	 */
	requireCorroboration?: boolean
	/**
	 * A3 (#625): add a normalized-phone comparison to the default model — strong evidence
	 * and the secondary corroborator that keeps A2 from killing name-drift recall.
	 *
	 * Ignored if `model` is supplied.
	 */
	usePhone?: boolean
	/**
	 * A4 (#625): clustering linkage.
	 *
	 * `"single"` (default) = connected components; `"average"` = average-linkage refinement that splits
	 * a component whose sub-clusters are joined only by a weak bridge — the principled over-merge fix.
	 */
	linkage?: "single" | "average"
	/**
	 * Extra secondary-identifier keys (from {@link SourceRecord.attributes}) to add as
	 * comparisons + corroborators — e.g. `["authorizedOfficial"]`.
	 *
	 * Ignored if `model` is supplied.
	 */
	discriminators?: string[]
	/**
	 * Closed-vocabulary code-SET discriminator keys ({@link DefaultModelOptions.exactDiscriminators} —
	 * set-overlap agreement, e.g. `["taxonomy"]`).
	 *
	 * Also corroborators.
	 * Ignored if `model` is supplied.
	 */
	exactDiscriminators?: string[]
	/**
	 * Override the Fellegi-Sunter link weight with a learned score (#603).
	 *
	 * When set, a candidate pair's match weight is this function's return value
	 * (same threshold-comparable units as the FS weight) instead of {@link scorePair}'s.
	 * Default undefined (pure FS).
	 *
	 * The blocking + clustering are unchanged, so a trained scorer can be A/B'd
	 * against the FS baseline on the identical pipeline.
	 * The function is responsible for its own feature computation
	 * (e.g. The agreement pattern, which is EM-independent, plus any corpus statistics it captured).
	 *
	 * Interaction with {@link requireCorroboration}: the two are independent and compose, but the
	 * corroboration check is still evaluated on the Fellegi-Sunter `contributions` (not the learned score).
	 * So a learned-high pair with no positive FS name/org/phone agreement is still held out.
	 *
	 * A learned scorer is normally trained to subsume corroboration, so use one or the other.
	 * Combining them lets the FS check veto the learned score, which is rarely what you want.
	 */
	scorer?: (a: SourceRecord, b: SourceRecord) => number
	/**
	 * **#603: the learned gradient-boosted-tree scorer — default-on.** Omitted
	 * or `true` uses the bundled {@link DEDUP_GBT_MODEL} (trained on the NPPES NPI-truth
	 * set. Beats the Fellegi-Sunter baseline ~+5pp dedup F1 held-out within a state
	 * and ~+22pp on states it never trained on, reducing the co-located over-merge).
	 *
	 * `false` opts out to the pure FS baseline.
	 * Pass your own {@link GBT} for a custom model.
	 *
	 * The scorer is built over the same collapsed-spatial + address-frequency feature model as training
	 * (via the resolved {@link addressFrequency}), independent of this call's comparison config.
	 * An explicit {@link scorer} takes precedence.
	 *
	 * When the bundled model is active and you don't set {@link threshold}, its calibrated
	 * link threshold ({@link DEDUP_GBT_META}.recommendedThreshold) is used.
	 * The GBT logit isn't in FS-weight units, so 0 would over-merge.
	 *
	 * The model is NPPES/US-trained.
	 * For a very different domain, A/B it or pass `false`.
	 */
	learnedScorer?: boolean | GBT
}

/**
 * The outcome of a resolve pass.
 */
export interface ResolveResult {
	entities: ResolvedEntity[]
	/**
	 * Number of candidate pairs blocking produced.
	 */
	candidatePairs: number
	/**
	 * Blocks too large to scan, surfaced so coverage limits are visible.
	 */
	droppedBlocks: Array<{ key: string; size: number }>
}

/**
 * Resolve source records into canonical entities: block → score → cluster.
 *
 * Every record lands in exactly one entity (a record with no confident link is its own singleton entity).
 */
export function resolveEntities(records: readonly SourceRecord[], config: ResolveConfig = {}): ResolveResult {
	// The proven changes are default-on (#625): the address-frequency down-weight
	// (auto-computed over the input records when not supplied; `false` disables) +
	// the collapsed spatial signal (A1).
	// A new caller gets the strong config out of the box.
	// Pass explicit values to override.
	const addressFrequency =
		config.addressFrequency === false
			? undefined
			: (config.addressFrequency ??
				buildTermFrequencyTable(
					records.map((r) => r.address?.raw),
					{ normalize: addressFrequencyKey }
				))

	const collapseSpatial = config.collapseSpatial ?? true

	const model =
		config.model ??
		buildDefaultModel({
			addressFrequency,
			collapseSpatial,
			usePhone: config.usePhone,
			discriminators: config.discriminators,
			exactDiscriminators: config.exactDiscriminators,
		})

	const blockingKeys = config.blockingKeys ?? defaultBlockingKeys()

	// #603: the learned scorer is default-on. An explicit `scorer` overrides everything. Otherwise `learnedScorer === false` opts out to the FS baseline, a GBT supplies a custom model, and `true`/omitted uses the bundled DEDUP_GBT_MODEL. The scorer is built over the fixed collapsed-spatial + address-frequency feature model (matching training, independent of this call's comparison config), using the resolved address-frequency table.
	let scorer = config.scorer
	let usingBundledModel = false

	if (!scorer && config.learnedScorer !== false) {
		const gbt =
			config.learnedScorer === undefined || config.learnedScorer === true ? DEDUP_GBT_MODEL : config.learnedScorer

		usingBundledModel = gbt === DEDUP_GBT_MODEL

		scorer = createGBTScorer({
			model: gbt,
			comparisons: buildDefaultModel({ collapseSpatial: true, addressFrequency }).comparisons,
			addressFrequency: addressFrequency ?? buildTermFrequencyTable([], { normalize: addressFrequencyKey }),
		})
	}

	// Threshold: an explicit value wins.
	// Else the bundled model's calibrated threshold when it's active
	// (its logit isn't in FS-weight units, so 0 would over-merge); else 0 (FS baseline or a custom model).
	const threshold = config.threshold ?? (usingBundledModel ? DEDUP_GBT_META.recommendedThreshold : 0)

	const { pairs, droppedBlocks } = block(records, blockingKeys, { maxBlockSize: config.maxBlockSize })

	let scoringModel = model

	if (config.trainEM && pairs.length) {
		const patterns = pairs.map(([a, b]) => agreementPattern(model.comparisons, a, b))
		scoringModel = estimateParameters(model, patterns).model
	}

	const links: ScoredLink<SourceRecord>[] = pairs.map(([a, b]) => {
		const score = scorePair(scoringModel, a, b)
		// #603: a learned scorer (explicit `scorer` or the opt-in `learnedScorer`) replaces the FS weight (same clustering + threshold semantics).
		let weight = scorer ? scorer(a, b) : score.weight

		// A2 (#625): a link must carry positive name or org corroboration.
		// A shared (even down-weighted) address alone is not identity.
		// Spatial-only pairs are suppressed below any threshold.
		if (config.requireCorroboration) {
			const corroborated = score.contributions.some(
				(c) => (CORROBORATING_FIELDS.has(c.name) || c.name.startsWith("attr:")) && c.weight > 0
			)

			if (!corroborated) {
				weight = Number.NEGATIVE_INFINITY
			}
		}

		return { a, b, weight }
	})

	const clusters = cluster(records, links, { threshold, linkage: config.linkage })

	// Cohesion = the weakest within-cluster link weight (how tightly an entity holds together). Compute it in one pass over links via a record→cluster index rather than by filtering every link for every cluster. The latter is O(clusters × links) and dominates the resolve at scale.
	const clusterOf = new Map<SourceRecord, number>()

	clusters.forEach((group, i) => {
		for (const record of group) {
			clusterOf.set(record, i)
		}
	})

	const minIntraWeight = new Array<number>(clusters.length).fill(Infinity)

	for (const link of links) {
		if (link.weight < threshold) continue
		const ci = clusterOf.get(link.a)

		if (ci === undefined || ci !== clusterOf.get(link.b)) continue

		if (link.weight < minIntraWeight[ci]!) {
			minIntraWeight[ci] = link.weight
		}
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
