/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Builds the query-intent markers that depend on the resolved answer. `geocodeAddressOnce` appends
 *   them to the kind classifier's markers. The markers never change which answer wins.
 *
 *   The decisive-margin threshold, the coincident-place radius and the margin function come from the
 *   ablation-expectation module, so the repository has one definition of a decisive margin.
 *
 *   WOF often stores a large city twice, once as `locality` and once as `localadmin`, with the same
 *   population. Without collapsing coincident places first, every major city would look ambiguous.
 */

import type { AddressNode, AddressTree, QueryIntentMarker, QueryKind } from "@mailwoman/core"
import { collectNodes } from "@mailwoman/core/decoder"

import {
	type AblationPlace,
	COINCIDENT_PLACE_KM,
	DECISIVE_MARGIN_LOG10,
	dominanceMarginLog10,
} from "#eval-harness/gauntlet/ablation/expectation"
import { collapseCoincident } from "#eval-harness/gauntlet/ablation/gazetteer"
import { tierRank } from "#eval-harness/gauntlet/ablation/scoring"
import type { ResolutionTier } from "#geocode/result"

/**
 * The fields of a resolver place that this module reads.
 *
 * `AddressNode.alternatives` is typed `ReadonlyArray<unknown>`, so the shape is declared here.
 */
interface RankedPlaceLike {
	id?: number | string
	name?: string
	placetype?: string
	country?: string
	lat?: number
	lon?: number
	/**
	 * The candidate's prominence.
	 *
	 * On the candidate backend it equals `-effectiveNegRank`, so a difference of
	 * two prominences is a log10 population margin.
	 * On the FTS backend it is a capped log population plus a proximity term, which is a different unit.
	 */
	prominence?: number
	score?: number
}

/**
 * Converts a resolver place into the shape that {@linkcode dominanceMarginLog10} reads.
 *
 * It returns null when the place lacks a name, coordinate or finite prominence.
 */
function toAblationPlace(place: RankedPlaceLike, rank: number): AblationPlace | null {
	if (place.lat == null || place.lon == null || !place.name) return null

	const prominence = place.prominence ?? place.score

	if (prominence == null || !Number.isFinite(prominence)) return null

	return {
		id: typeof place.id === "number" ? place.id : rank,
		name: place.name,
		placetype: place.placetype ?? "locality",
		country: place.country ?? "",
		lat: place.lat,
		lon: place.lon,
		// The margin calculation never reads the bounding box.
		bbox: null,
		negRank: -prominence,
		population: null,
	}
}

/**
 * Returns the resolved node that the answer's coordinate came from.
 *
 * The selection matches `primaryNode` in `extractGeocodeResult`, so the marker
 * and the candidate list describe the same place.
 */
function primaryResolvedNode(tree: AddressTree, lat: number | null, lon: number | null): AddressNode | null {
	const all = collectNodes(tree.roots, () => true)

	return (
		all.find((n) => n.metadata?.["resolver_name"] && n.lat === lat && n.lon === lon) ??
		all.find((n) => n.metadata?.["resolver_name"] && n.lat != null) ??
		null
	)
}

/**
 * Options for {@linkcode declaredAmbiguityMarker}.
 */
export interface DeclaredAmbiguityOpts {
	/**
	 * The top kind and every alternative kind from the verdict.
	 *
	 * The classifier reports `bare_toponym` as an alternative, so passing only
	 * the top kind means the marker never fires.
	 */
	kinds: ReadonlyArray<QueryKind>
	tree: AddressTree
	lat: number | null
	lon: number | null
}

/**
 * Returns a `declared_ambiguity` marker when a bare place-name query has no decisive winner.
 *
 * @returns `null` when the query is not a bare toponym, when fewer than two distinct
 * places can be ranked, or when the margin reaches {@linkcode DECISIVE_MARGIN_LOG10}.
 */
export function declaredAmbiguityMarker(opts: DeclaredAmbiguityOpts): QueryIntentMarker | null {
	if (!opts.kinds.includes("bare_toponym")) return null

	const node = primaryResolvedNode(opts.tree, opts.lat, opts.lon)

	if (!node?.lat || node.lon == null) return null

	const self: RankedPlaceLike = {
		id: node.placeID,
		name: (node.metadata?.["resolver_name"] as string | undefined) ?? node.value,
		placetype: node.tag,
		country: node.metadata?.["resolver_country"] as string | undefined,
		lat: node.lat,
		lon: node.lon,
		prominence: node.metadata?.["resolver_prominence"] as number | undefined,
		score: node.metadata?.["resolver_score"] as number | undefined,
	}

	const ranked = [self, ...((node.alternatives as ReadonlyArray<RankedPlaceLike> | undefined) ?? [])]
	const places = ranked.map(toAblationPlace).filter((p): p is AblationPlace => p !== null)

	// With fewer than two rankable places the margin is unmeasured.
	// The FTS path does not always stamp a prominence.
	if (places.length < 2) return null

	const distinct = collapseCoincident(places)

	if (distinct.length < 2) return null

	const margin = dominanceMarginLog10(distinct)

	if (margin >= DECISIVE_MARGIN_LOG10) return null

	const [winner, runnerUp] = distinct

	return {
		kind: "bare_toponym",
		code: "declared_ambiguity",
		mechanism: "resolver:dominance_margin",
		message:
			`"${winner!.name}" names ${distinct.length} distinct places and the top-two margin is ` +
			`${margin.toFixed(2)}, below the measured decisive threshold of ${DECISIVE_MARGIN_LOG10}. The answer below is the ` +
			`top-ranked one and it was not a clear win.`,
		evidence: {
			margin: Number(margin.toFixed(4)),
			decisiveMarginLog10: DECISIVE_MARGIN_LOG10,
			// The margin is a log10 population difference on the candidate backend.
			// On the FTS backend the prominence is capped and includes a proximity term.
			marginUnit: "resolver_prominence_delta",
			coincidentCollapseKm: COINCIDENT_PLACE_KM,
			distinctPlaces: distinct.length,
			runnerUp: runnerUp
				? { name: runnerUp.name, placetype: runnerUp.placetype, country: runnerUp.country || null }
				: null,
		},
	}
}

/**
 * The coarsest tier that still uses each parsed component, compared with {@linkcode tierRank}.
 *
 * An interpolated point locates a house number, so `house_number` needs only `interpolated`.
 * A postcode centroid is street-grade in most address systems, so `postcode` needs only `street`.
 * `unit` has no floor because no layer locates units.
 */
const COMPONENT_TIER_FLOOR: ReadonlyArray<readonly [tag: string, floor: ResolutionTier]> = [
	["house_number", "interpolated"],
	["street", "street"],
	["postcode", "street"],
]

/**
 * Options for {@linkcode coarserAnswerMarker}.
 */
export interface CoarserAnswerOpts {
	/**
	 * The top kind and every alternative kind from the verdict.
	 * The marker uses the top kind.
	 */
	kinds: ReadonlyArray<QueryKind>
	/**
	 * The parsed components by tag.
	 * Only their presence is read.
	 */
	components: Readonly<Record<string, string | null | undefined>>
	reachedTier: ResolutionTier
}

/**
 * Returns a `declared_coarser_answer` marker when the query supplied components
 * finer than the tier the answer reached.
 *
 * @returns `null` when no supplied component needs a finer tier than the one reached.
 */
export function coarserAnswerMarker(opts: CoarserAnswerOpts): QueryIntentMarker | null {
	// `tierRank` ranks `venue` and `plus_code` as house-grade, so those answers meet every floor.
	const reached = tierRank(opts.reachedTier)

	const unused = COMPONENT_TIER_FLOOR.filter(([tag, floor]) => opts.components[tag] && reached < tierRank(floor))

	if (!unused.length) return null

	// The answer needed the finest of the unused floors to use every component.
	let floorTier = unused[0]![1]

	for (const [, floor] of unused) {
		if (tierRank(floor) > tierRank(floorTier)) {
			floorTier = floor
		}
	}

	const tags = unused.map(([tag]) => tag)
	const kind = opts.kinds[0] ?? "structured_address"

	return {
		kind,
		code: "declared_coarser_answer",
		mechanism: "resolver:tier_shortfall",
		message:
			`The query supplied ${tags.join(", ")}, which ${tags.length === 1 ? "is" : "are"} located no coarser than ` +
			`${floorTier}, and the walk reached ${opts.reachedTier}. The coordinate below is the ` +
			`${opts.reachedTier}-grade one; it does not locate the ${tags[0]}.`,
		evidence: {
			unusedComponents: tags,
			requiredTier: floorTier,
			reachedTier: opts.reachedTier,
		},
	}
}
