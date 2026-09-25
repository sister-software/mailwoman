/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { PlacetypeMap } from "@mailwoman/codex/placetype-map"
import { walkNodes, type AddressNode } from "@mailwoman/core/decoder"
import {
	type CoincidentLocality,
	compareReferential,
	type ResolveCandidateTrace,
	type ResolveNodeTrace,
	type PostcodePrefixIndexLike,
	referentialFromPopulation,
	type ResolvedPlace,
	type ResolveOpts,
	type ResolverBackend,
} from "@mailwoman/core/resolver"
import { PLACETYPE_SPECIFICITY } from "@mailwoman/core/resources/whosonfirst/specificity"
import { haversineKm } from "@mailwoman/spatial"

import { decorateNode, isResolvedWithCoord } from "#decorate-node"
import type { CoordinateOptionalPlace } from "#postcode/prefix"
import { isShapeExcludedPostcode } from "#postcode/shape-coherence"
import { findRescoreCandidate, hasResolvedPlace, postcodeCodeSubset } from "#span-rescore"

const TRACE_CANDIDATE_CAP = 10

const FINEST_DIAGNOSTIC_BAND = PLACETYPE_SPECIFICITY["microhood"]!

const COARSEST_DIAGNOSTIC_BAND = PLACETYPE_SPECIFICITY["country"]!

/**
 * The admin placetypes from country to microhood that `ResolveOpts.diagnoseUnreachable`
 * re-probes, coarse to fine.
 *
 * The list derives from `PLACETYPE_SPECIFICITY`, so a new placetype in that range is probed automatically.
 */
export const DIAGNOSTIC_BANDS: readonly string[] = Object.entries(PLACETYPE_SPECIFICITY)
	.filter(([, rank]) => rank !== undefined && rank <= FINEST_DIAGNOSTIC_BAND && rank >= COARSEST_DIAGNOSTIC_BAND)
	.toSorted((a, b) => (a[1] as number) - (b[1] as number))
	.map(([placetype]) => placetype)

/**
 * Collects the trace for one placetype lookup and emits it as a `ResolveNodeTrace`.
 *
 * The walk always calls a recorder and uses {@link NOOP_TRACE_RECORDER} when no
 * trace sink is set, so the hot path has no per-event branches.
 */
export interface NodeTraceRecorder {
	bind(
		node: AddressNode,
		placetype: string,
		query: {
			country?: string
			parentID?: string | number
			postcode?: string
			regionQualifier?: string
			limit?: number
		},
		defaultLimit: number
	): void
	check(name: string): void
	stage(name: string, order: readonly ResolvedPlace[]): void
	reachable(bands: NonNullable<ResolveNodeTrace["reachableIn"]>): void
	emit(picked: NonNullable<ResolveNodeTrace["picked"]> | null): void
}

/**
 * A {@link NodeTraceRecorder} that records nothing, for walks without a trace sink.
 */
export const NOOP_TRACE_RECORDER: NodeTraceRecorder = Object.freeze({
	bind() {},
	check() {},
	stage() {},
	reachable() {},
	emit() {},
})

/**
 * Creates a {@link NodeTraceRecorder} that sends one `ResolveNodeTrace` to `sink` on `emit`.
 *
 * The record lists at most ten candidates from the last stage, with each candidate's rank in every stage.
 */
export function createNodeTraceRecorder(sink: (record: ResolveNodeTrace) => void): NodeTraceRecorder {
	const checks: string[] = []
	const stageOrders: Array<[string, readonly ResolvedPlace[]]> = []

	let reachableIn: ResolveNodeTrace["reachableIn"]

	let ctx: {
		node: AddressNode
		placetype: string
		query: Parameters<NodeTraceRecorder["bind"]>[2]
		defaultLimit: number
	} | null = null

	return {
		bind(node, placetype, query, defaultLimit) {
			ctx = { node, placetype, query, defaultLimit }
		},
		check(name) {
			checks.push(name)
		},
		stage(name, order) {
			stageOrders.push([name, order])
		},
		reachable(bands) {
			reachableIn = bands
		},
		emit(picked) {
			if (!ctx) return

			const rankMap = new Map<ResolvedPlace, Record<string, number>>()

			for (const [stage, order] of stageOrders) {
				order.forEach((candidate, index) => {
					let ranks = rankMap.get(candidate)

					if (!ranks) {
						ranks = {}
						rankMap.set(candidate, ranks)
					}

					ranks[stage] = index + 1
				})
			}

			const finalOrder = stageOrders.at(-1)?.[1] ?? []

			const rows: ResolveCandidateTrace[] = finalOrder.slice(0, TRACE_CANDIDATE_CAP).map((c) => ({
				id: c.id,
				name: c.name,
				country: c.country,
				placetype: c.placetype,
				score: c.score,
				...(c.prominence !== undefined ? { prominence: c.prominence } : {}),
				...(c.importance !== undefined ? { importance: c.importance } : {}),
				...(c.population !== undefined ? { population: c.population } : {}),
				...(c.exactMatch !== undefined ? { exactMatch: c.exactMatch } : {}),
				...(c.containedByQualifier !== undefined ? { containedByQualifier: c.containedByQualifier } : {}),
				ranks: rankMap.get(c) ?? {},
			}))

			sink({
				tag: ctx.node.tag,
				value: ctx.node.value,
				placetype: ctx.placetype,
				query: {
					...(ctx.query.country ? { country: ctx.query.country } : {}),
					...(ctx.query.parentID !== undefined ? { parentID: ctx.query.parentID } : {}),
					...(ctx.query.postcode ? { postcode: ctx.query.postcode } : {}),
					...(ctx.query.regionQualifier ? { regionQualifier: ctx.query.regionQualifier } : {}),
					limit: ctx.query.limit ?? ctx.defaultLimit,
				},
				checks,
				...(reachableIn ? { reachableIn } : {}),
				candidates: rows,
				candidatesTruncated: Math.max(0, finalOrder.length - TRACE_CANDIDATE_CAP),
				picked,
			})
		},
	}
}

/**
 * The options and mutable state that one `resolveTree` call passes through its tree walk.
 */
export interface ResolutionState {
	lookupsRemaining: number
	placetypeMap: PlacetypeMap
	minWinningScore: number

	/**
	 * The count of lookups rejected by {@link ResolutionState.minWinningScore}.
	 *
	 * A nonzero count skips the span-rescore pass, which would otherwise treat the
	 * refused node as unresolved and repeat the rejected lookup.
	 */
	minScoreRefusals: number
	candidatesPerLookup: number
	defaultCountry?: string

	/**
	 * Whether {@link ResolutionState.defaultCountry} came from the locale instead of the caller.
	 *
	 * `country` lookups ignore an inferred default.
	 */
	defaultCountryIsInferred: boolean

	/**
	 * The tree's only value-bearing node when it maps to `locality`, or null otherwise.
	 *
	 * Its lookup also probes countries and regions of the same name, because the locality
	 * placetype filter cannot reach a country that the parser tagged as a locality.
	 */
	bareLocalityNode: AddressNode | null
	parentFallback: boolean

	/**
	 * The tree's first postcode value.
	 *
	 * Locality lookups send it to the backend, which can then favor nearby candidates.
	 */
	postcode?: string

	/**
	 * Whether locality lookups ask the backend to re-rank candidates by distance to the postcode centroid.
	 */
	postcodeContainmentCoherence: boolean

	/**
	 * Whether a `postalcode` lookup that misses falls back to {@link ResolutionState.postcodePrefixIndex}.
	 */
	postcodePrefixPrior: boolean

	/**
	 * The countries implied by the postcode's format.
	 *
	 * A `postalcode` lookup without a country scope probes only these countries
	 * and abstains if all of them miss.
	 * An unscoped probe of a space-stripped code can match another country's postcode system.
	 */
	postcodeFormatCountries?: readonly string[]

	/**
	 * The locale hint's country, sent as `fuzzyCountry` on every lookup.
	 * It scopes only the typo-fuzzy tier.
	 */
	fuzzyCountryScope?: string

	/**
	 * The postcode prefix index that {@link ResolutionState.postcodePrefixPrior} requires.
	 */
	postcodePrefixIndex?: PostcodePrefixIndexLike

	/**
	 * Proximity-bias points, such as a viewport or user location, that every
	 * lookup uses to reorder candidates.
	 */
	bias?: Array<{ lat: number; lon: number; weight?: number }>

	/**
	 * The postcode anchor's posterior over countries, used to re-rank region and locality candidates.
	 *
	 * When set, it also replaces the importance re-rank and capital promotion.
	 */
	anchorPosterior?: Record<string, number>

	/**
	 * The weight on {@link ResolutionState.anchorPosterior} in the re-rank key.
	 */
	anchorWeight: number

	/**
	 * The callback that receives one trace record per lookup.
	 * The walk records nothing when it is absent.
	 */
	traceSink?: (record: ResolveNodeTrace) => void

	/**
	 * Whether an empty lookup re-probes the other admin bands and traces which ones hold the value.
	 *
	 * It is set only when a trace sink exists, and it never affects the pick.
	 */
	diagnoseUnreachable?: boolean

	/**
	 * The locale country used as a soft prior on region and locality candidates
	 * when no default country or anchor posterior applies.
	 */
	localeCountryPrior?: string

	/**
	 * The weight of {@link ResolutionState.localeCountryPrior}, in log10-population units.
	 */
	localeCountryPriorWeight: number

	/**
	 * Returns a candidate's capital level for bounded capital promotion.
	 * Capital promotion is off when it is absent.
	 */
	capitalLevel?: (place: { name: string; country?: string; lat: number; lon: number }) => number

	/**
	 * The country scope applied to a lookup when no parent, default country, or node hint supplies one.
	 */
	hardCountry?: string

	/**
	 * Whether a resolved region gains its coincident locality of the same name as an
	 * interpretation when the tree has no locality node.
	 */
	hierarchyCompletion: boolean

	/**
	 * Whether each resolved node gets its ancestor lineage in metadata, when the backend supports it.
	 */
	includeAncestors: boolean

	/**
	 * Whether locality candidates contained by {@link ResolutionState.regionQualifier}
	 * are ordered ahead of the rest.
	 */
	adminContainmentRerank: boolean

	/**
	 * The tree's first region value.
	 *
	 * The region and locality nodes are siblings, so the walk would not otherwise
	 * pass the region to the locality lookup.
	 * It applies only with {@link ResolutionState.adminContainmentRerank}
	 * and no caller-supplied default country.
	 */
	regionQualifier?: string

	/**
	 * Whether any node maps to the `locality` placetype.
	 * Hierarchy completion runs only when this is false.
	 */
	localityNodePresent: boolean

	/**
	 * The first resolved region place, used to look up its coincident locality.
	 */
	resolvedRegion: CoordinateOptionalPlace | null

	/**
	 * The decorated node for {@link ResolutionState.resolvedRegion}.
	 *
	 * Hierarchy completion adds the locality interpretation to it in place.
	 */
	resolvedRegionNode: AddressNode | null
}

/**
 * Picks the completion locality among coincident candidates of the same name,
 * preferring the most populous and then the nearest.
 * It returns `null` on an exact tie.
 *
 * Population ranks above distance because a principal city can lie farther from
 * the admin centroid than a hamlet of the same name.
 */
export function pickCompletion(candidates: readonly CoincidentLocality[]): CoincidentLocality | null {
	if (!candidates.length) return null

	if (candidates.length === 1) return candidates[0]!

	const ranked = [...candidates]
		.map((c) => ({ c, referential: referentialFromPopulation(c.population), population: c.population }))
		// oxlint-disable-next-line unicorn/no-array-sort -- sorts a freshly-built array. toSorted would double-allocate on a hot path
		.sort((a, b) => compareReferential(a, b) || a.c.distanceKm - b.c.distanceKm)
		.map((x) => x.c)

	const [first, second] = ranked

	if (first!.population === second!.population && first!.distanceKm === second!.distanceKm) return null

	return first!
}

/**
 * Returns the first postcode value anywhere in the tree, skipping shape-excluded postcodes.
 *
 * A locality lookup uses it because the postcode node is usually a sibling of the locality.
 */
export function firstPostcodeValue(roots: readonly AddressNode[]): string | undefined {
	for (const n of walkNodes(roots)) {
		if (n.tag === "postcode" && !isShapeExcludedPostcode(n) && n.value.trim().length) return n.value.trim()
	}

	return undefined
}

/**
 * Recovers a locality from raw-text spans when the tree resolved no place,
 * and appends a resolved `locality` node on a hit.
 *
 * When no span matches, it tries to resolve the postcode node from the code
 * part of a compound postcode value.
 */
export async function applySpanRescore(
	roots: AddressNode[],
	raw: string,
	backend: ResolverBackend,
	opts: ResolveOpts
): Promise<void> {
	if (hasResolvedPlace(roots, opts.spanRescoreWeakResolution ?? false)) return

	let hit

	try {
		hit = await findRescoreCandidate(raw, roots, backend, {
			country: opts.defaultCountry,
			postcode: firstPostcodeValue(roots),
			thresholdKm: opts.spanRescoreThresholdKm,

			postalCompoundRecovery: opts.postalCompoundRecovery !== false,
			spanRescoreRequireContextRemainder: opts.spanRescoreRequireContextRemainder,
		})
	} catch {
		return
	}

	if (!hit && opts.postalCompoundRecovery !== false) {
		try {
			await recoverPostcodeNode(roots, backend, opts.defaultCountry, opts.traceSink)
		} catch {}
	}

	if (!hit) return

	const node: AddressNode = {
		tag: "locality",
		value: hit.text,
		start: hit.start,
		end: hit.end,

		confidence: 0.5,
		children: [],
	}

	decorateNode(node, hit.place, hit.alternatives)

	node.metadata = { ...node.metadata, span_rescore: true, rescore_postcode_verified: hit.postcodeVerified }
	roots.push(node)

	if (opts.traceSink) {
		const rec = createNodeTraceRecorder(opts.traceSink)

		rec.bind(node, "locality", opts.defaultCountry ? { country: opts.defaultCountry } : {}, 1)
		rec.check("span_rescore")
		rec.check(hit.postcodeVerified ? "rescore_postcode_verified" : "rescore_postcode_unverified")
		rec.stage("rescore", [hit.place, ...hit.alternatives])
		rec.emit({ id: hit.place.id, name: hit.place.name, source: "span_rescore" })
	}
}

async function recoverPostcodeNode(
	roots: AddressNode[],
	backend: ResolverBackend,
	country: string | undefined,
	traceSink?: (record: ResolveNodeTrace) => void
): Promise<void> {
	for (const n of walkNodes(roots)) {
		if (n.tag === "postcode" && !n.placeID && n.value.trim()) {
			const code = postcodeCodeSubset(n.value)

			if (!code || code === n.value.trim()) continue
			const hits = await backend.findPlace({ text: code, placetype: "postalcode", country, limit: 1 })
			const top = hits.find((h) => h.lat !== 0 || h.lon !== 0)

			if (top) {
				decorateNode(n, top, [])
				n.metadata = { ...n.metadata, postal_compound_recovered: true }

				if (traceSink) {
					const rec = createNodeTraceRecorder(traceSink)

					rec.bind(n, "postalcode", { ...(country ? { country } : {}), limit: 1 }, 1)
					rec.check("postal_compound_recovery")
					rec.stage("recovery", hits)
					rec.emit({ id: top.id, name: top.name, source: "postal_compound_recovery" })
				}
			}

			return
		}
	}
}

/**
 * The farthest distance, in kilometres, that {@link applyPostcodeConsistency}
 * moves a locality onto its postcode's point.
 *
 * The value sits above the 99th percentile of distances between agreeing postcodes and settlements.
 */
export const DEFAULT_POSTCODE_MAX_MOVE_KM = 300

/**
 * Reconciles each resolved locality that lies farther than `thresholdKm` from
 * the tree's resolved postcode point.
 *
 * It re-picks the nearest alternative within the threshold.
 * Without one, it flags `postcode_city_mismatch` and moves the coordinate to the postcode point.
 *
 * It skips the move when the distance exceeds `maxMoveKm`, because a mistyped
 * but valid postcode can point far away.
 */
export function applyPostcodeConsistency(
	roots: readonly AddressNode[],
	thresholdKm: number,
	maxMoveKm = DEFAULT_POSTCODE_MAX_MOVE_KM
): void {
	let anchor: { lat: number; lon: number } | null = null

	for (const n of walkNodes(roots)) {
		if (n.tag === "postcode" && !isShapeExcludedPostcode(n) && isResolvedWithCoord(n)) {
			anchor = { lat: n.lat!, lon: n.lon! }

			break
		}
	}

	if (!anchor) return

	for (const node of walkNodes(roots)) {
		if ((node.tag !== "locality" && node.tag !== "dependent_locality") || !isResolvedWithCoord(node)) continue

		const gapKm = haversineKm(anchor.lat, anchor.lon, node.lat!, node.lon!)

		if (gapKm <= thresholdKm) continue

		const alts = (node.alternatives as ResolvedPlace[] | undefined) ?? []

		const reconciling = alts
			.filter((a) => a.lat !== 0 || a.lon !== 0)
			.map((a) => ({ a, d: haversineKm(anchor!.lat, anchor!.lon, a.lat, a.lon) }))
			.filter((x) => x.d <= thresholdKm)
			// oxlint-disable-next-line unicorn/no-array-sort -- sorts a freshly-built array. toSorted would double-allocate on a hot path
			.sort((x, y) => x.d - y.d)[0]

		if (reconciling) {
			const displaced: ResolvedPlace = {
				id: 0,
				name: String(node.metadata?.["resolver_name"] ?? node.value),
				placetype: "locality",
				country: reconciling.a.country,
				lat: node.lat!,
				lon: node.lon!,
				score: 0,
			}

			const rest = alts.filter((a) => a !== reconciling.a)
			decorateNode(node, reconciling.a, [displaced, ...rest])
			node.metadata = { ...node.metadata, postcode_repicked: true }

			continue
		}

		if (gapKm > maxMoveKm) {
			node.metadata = { ...node.metadata, postcode_city_mismatch: true, postcode_move_refused_km: gapKm }

			continue
		}

		node.lat = anchor.lat
		node.lon = anchor.lon
		node.metadata = { ...node.metadata, postcode_city_mismatch: true, coordinate_source: "postcode_fallback" }
	}
}
