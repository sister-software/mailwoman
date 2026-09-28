/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The resolve pipeline wires the matching modules over concrete contact and organization records.
 *
 *   Geocoding is assumed already done upstream, so each `address` carries its coordinate and
 *   canonical key.
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
 * Cheap, parse-free normalization for the address-frequency key: uppercase,
 * collapse whitespace, drop punctuation.
 *
 * The count covers distinct entities that share an address.
 * It is computable over millions of rows without geocoding.
 *
 * A crowded clinic or billing address is weak identity evidence.
 * A lonely address is strong.
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
 * Exact-vs-different levels for a closed-vocabulary code set
 * ({@link DefaultModelOptions.exactDiscriminators}), such as NPPES taxonomy codes or license numbers.
 *
 * These are seeds only, since EM refits.
 * `u` starts well above phone's 0.002, because two random providers share a
 * specialty far more often than a phone line.
 */
const CODE_SET_LEVELS: ComparisonLevel[] = [
	{ label: "exact", minSimilarity: 1, m: 0.75, u: 0.08 },
	{ label: "different", minSimilarity: 0, m: 0.25, u: 0.92 },
]

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
 * Last-10-digit normalization for phone agreement, dropping country code, punctuation and extensions.
 *
 * A shorter digit string is kept as-is, since partial agreement still carries
 * weight in the comparison model.
 * `null` means no digits at all.
 */
export function normalizePhone(raw: string | null | undefined): string | null {
	if (!raw) return null
	const digits = raw.replaceAll(/\D+/g, "")

	return digits.length >= 10 ? digits.slice(-10) : digits || null
}

/**
 * {@link normalizePhone} under the probes' stricter interface, where only a full line counts.
 *
 * Returns the last 10 digits when the input contains at least 10.
 * Returns `""` for shorter input, so callers never receive a partial digit string.
 *
 * Callers guard on truthiness, so `""` reads as no comparable phone rather than a weaker key.
 */
export function normalizePhoneStrict(raw: string | null | undefined): string {
	const digits = normalizePhone(raw)

	return digits && digits.length === 10 ? digits : ""
}

/**
 * The identity-corroborating comparisons: person name, organization and phone.
 *
 * At least one must positively agree before a pair may link, since a shared
 * address alone carries no identity evidence.
 * Phone is the secondary identifier that rescues a true same-entity link across name drift.
 */
const CORROBORATING_FIELDS = new Set(["given", "family", "organization", "phone"])

/**
 * Options for {@link buildDefaultModel}.
 *
 * Each change is default-off, so the base model is byte-stable.
 */
export interface DefaultModelOptions {
	/**
	 * Corpus-wide address-frequency table over {@link addressFrequencyKey}, which makes
	 * the address agreement weight inverse to how shared the address is.
	 *
	 * A building with 50 providers makes a same-address match near-worthless evidence.
	 *
	 * The table's `value` is the record's raw address string.
	 */
	addressFrequency?: TermFrequencyTable
	/**
	 * Collapse the redundant address-key and great-circle-distance comparisons into one
	 * {@link spatialComparison spatial-agreement} signal, an exact-key tier over distance buckets.
	 *
	 * Removes the double-count that over-merges co-located providers, since an
	 * exact key match already implies distance ≈ 0.
	 */
	collapseSpatial?: boolean
	/**
	 * Add a normalized-phone exact-match comparison.
	 *
	 * A shared line is strong evidence and the secondary corroborator that lets a
	 * true same-entity link survive name drift.
	 */
	usePhone?: boolean
	/**
	 * Extra secondary-identifier comparisons drawn from {@link SourceRecord.attributes},
	 * such as `["authorizedOfficial"]`.
	 *
	 * Each becomes an `attr:<key>` comparison and counts toward corroboration.
	 * It is a more reliable discriminator than phone where the data has one.
	 */
	discriminators?: string[]
	/**
	 * Closed-vocabulary code-set discriminators drawn from {@link SourceRecord.attributes},
	 * such as NPPES taxonomy codes or license numbers.
	 *
	 * The attribute value is a whitespace-joined set of codes.
	 * Any shared code counts as agreement.
	 *
	 * This is set overlap rather than string similarity, since `207R00000X`
	 * and `207Q00000X` are different specialties despite near-identical text.
	 *
	 * String similarity mis-scores that case.
	 * The over-merge separator: two co-located records of one entity nearly always share
	 * a code, while two distinct co-located providers usually do not.
	 */
	exactDiscriminators?: string[]
}

/**
 * The default geocode-first scoring model: name, organization and a spatial signal.
 *
 * The spatial signal is either two comparisons (address-key similarity and great-circle distance)
 * or, with {@link DefaultModelOptions.collapseSpatial}, one collapsed {@link spatialComparison}.
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
				similarity: (a, b) => (a === b ? 1 : 0),
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
				similarity: codeSetOverlap,
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
				levels: [0],
			})
		}

		return { lambda: 0.0001, comparisons: [...identity, spatial] }
	}

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
 * The default blocking keys include location and canonical address.
 * They also include phone and email.
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
	 * Address-frequency table over {@link addressFrequencyKey}, which down-weights address
	 * agreement by how shared the address is. **Default-on:** when omitted, `resolveEntities`
	 * computes the table over the input records' addresses, the right scope for a single dataset.
	 *
	 * Pass your own {@link TermFrequencyTable} (for example a corpus-wide one) to override,
	 * or `false` to disable (the legacy bare baseline).
	 * Ignored if `model` is supplied.
	 */
	addressFrequency?: TermFrequencyTable | false
	/**
	 * Collapse the redundant address-key and distance pair into one {@link spatialComparison}.
	 * **Default-on (true)** is the cleaner, less-over-merging spatial model.
	 *
	 * Set `false` for the legacy two-signal baseline.
	 * Ignored if `model` is supplied.
	 */
	collapseSpatial?: boolean
	/**
	 * Require positive name or organization corroboration ({@link CORROBORATING_FIELDS})
	 * for a link, so a shared address alone cannot merge two records.
	 *
	 * Suppresses the spatial-only links that fuse distinct co-located providers.
	 * Default false.
	 */
	requireCorroboration?: boolean
	/**
	 * Add a normalized-phone comparison to the default model.
	 *
	 * Phone agreement provides strong secondary evidence when entity names have drifted.
	 *
	 * Ignored if `model` is supplied.
	 */
	usePhone?: boolean
	/**
	 * Clustering linkage.
	 *
	 * `"single"` (default) is connected components, while `"average"` is an average-linkage
	 * refinement that splits a component whose sub-clusters are joined only by a weak bridge.
	 */
	linkage?: "single" | "average"
	/**
	 * Extra secondary-identifier keys from {@link SourceRecord.attributes} to add as
	 * comparisons and corroborators, for example `["authorizedOfficial"]`.
	 *
	 * Ignored if `model` is supplied.
	 */
	discriminators?: string[]
	/**
	 * Closed-vocabulary code-set discriminator keys ({@link DefaultModelOptions.exactDiscriminators}),
	 * which use set-overlap agreement.
	 * An example is `["taxonomy"]`.
	 *
	 * Also corroborators.
	 * Ignored if `model` is supplied.
	 */
	exactDiscriminators?: string[]
	/**
	 * Override the Fellegi-Sunter link weight with a learned score.
	 *
	 * When set, a candidate pair's match weight is this function's return value instead of
	 * {@link scorePair}'s, in the same threshold-comparable units as the FS weight.
	 * Default is undefined (pure FS).
	 *
	 * The blocking and clustering are unchanged, so a trained scorer can be A/B tested
	 * against the FS baseline on the identical pipeline.
	 * The function is responsible for its own feature computation, such as the
	 * agreement pattern plus any corpus statistics it captured.
	 *
	 * The corroboration check is independent of the learned score and is still evaluated on
	 * the Fellegi-Sunter `contributions`, so a learned-high pair with no positive FS name,
	 * organization or phone agreement is still held out.
	 *
	 * A learned scorer is normally trained to subsume corroboration, so use one or the other.
	 * Combining them lets the FS check veto the learned score.
	 */
	scorer?: (a: SourceRecord, b: SourceRecord) => number
	/**
	 * The learned gradient-boosted-tree scorer, default-on.
	 *
	 * Omitted or `true` uses the bundled {@link DEDUP_GBT_MODEL}, which was trained on
	 * the NPPES NPI-truth set and beats the Fellegi-Sunter baseline by roughly +5pp dedup
	 * F1 held-out within a state and +22pp on states it never trained on.
	 *
	 * `false` opts out to the pure FS baseline.
	 * Pass your own {@link GBT} for a custom model.
	 *
	 * The scorer is built over the same collapsed-spatial and address-frequency feature
	 * model as training, independent of this call's comparison config.
	 * An explicit {@link scorer} takes precedence.
	 *
	 * When the bundled model is active and no {@link threshold} is set,
	 * its calibrated link threshold ({@link DEDUP_GBT_META}.recommendedThreshold) is used,
	 * because the GBT logit is not in FS-weight units and 0 would over-merge.
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
 * Resolve source records into canonical entities: block, score, cluster.
 *
 * Every record belongs to exactly one entity.
 * A record without a confident link forms a singleton entity.
 */
export function resolveEntities(records: readonly SourceRecord[], config: ResolveConfig = {}): ResolveResult {
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

	// An explicit threshold wins.
	// Otherwise the bundled model uses its calibrated threshold, because its logit
	// is not in FS-weight units and 0 would over-merge.
	// The FS baseline or a custom model uses 0.
	const threshold = config.threshold ?? (usingBundledModel ? DEDUP_GBT_META.recommendedThreshold : 0)

	const { pairs, droppedBlocks } = block(records, blockingKeys, { maxBlockSize: config.maxBlockSize })

	let scoringModel = model

	if (config.trainEM && pairs.length) {
		const patterns = pairs.map(([a, b]) => agreementPattern(model.comparisons, a, b))
		scoringModel = estimateParameters(model, patterns).model
	}

	const links: ScoredLink<SourceRecord>[] = pairs.map(([a, b]) => {
		const score = scorePair(scoringModel, a, b)
		let weight = scorer ? scorer(a, b) : score.weight

		// A link must carry positive name or organization corroboration, since a shared
		// address alone carries no identity evidence.
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

	// Cohesion is the weakest within-cluster link weight.
	// Compute it in one pass over links with a record-to-cluster index, because filtering
	// every link for every cluster is O(clusters x links) and dominates the resolve at scale.
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
