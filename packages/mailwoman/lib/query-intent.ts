/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   the declared-ambiguity marker (ROAD_TO_V9 §4.2 + the §4 guessing doctrine).
 *
 *   > when the dominance margin is thin (the measured 0.5 log10 line from the ablation-ladder work),
 *   > return the winner with declared ambiguity — the suggestion layer's nudge shape — and never
 *   > resolve a bare query to an obscure feature type silently.
 *
 *   The three other intent markers are raised by the kind classifier, from the string alone
 *   (`@mailwoman/kind-classifier`'s `intent-markers.ts`). This one cannot be: its trigger is a
 *   property of the resolved candidate list, which appears after Stage 6. So it lives
 *   here, on the geocode path, and `geocodeAddressOnce` appends it to the classifier's markers.
 *
 *   ## Reuse rather than re-derivation
 *
 *   {@linkcode DECISIVE_MARGIN_LOG10} (0.5) and {@linkcode COINCIDENT_PLACE_KM} (10) are imported
 *   from the ablation-expectation model rather than restated. Both are measured numbers with a table
 *   behind them (see that module's docstring: below 0.5 the top-ranked place is the intended one
 *   52.4% of the time, above it 89.1%), and a second copy would be a second thing to keep in sync
 *   with a measurement nobody re-runs. `dominanceMarginLog10` itself is imported too — the
 *   subtraction is three lines, and the point is that there is one definition of "decisive" in this
 *   repo.
 *
 *   The import crosses from `eval-harness/` into the production geocode path, which is unusual and
 *   deliberate. The alternative was moving the constants into `@mailwoman/core` (a shipped-package
 *   change for two numbers, with the eval harness then importing them back) or copying them (a
 *   silent-drift generator). The module imports nothing but `@mailwoman/spatial`, so the cost is a
 *   type-strip rather than a dependency.
 *
 *   ## The collapse is required
 *
 *   WOF stores a big city twice — Paris the `locality` and Paris the `localadmin`, same population —
 *   so a RAW top-2 margin reads 0.01 for Paris and 0.00 for Washington. Uncollapsed, every major city
 *   reads maximally ambiguous and this marker fires on every capital in the world.
 *   `extractGeocodeResult`'s own candidate list already de-dupes, but on an ~11 m grid, which is two
 *   orders of magnitude too tight for this job. So the collapse here is at
 *   {@linkcode COINCIDENT_PLACE_KM} and it runs on the resolver's places, before the geocode result's
 *   de-dupe, which is the only place the prominence column is still attached.
 *
 *   ## What it does not do
 *
 *   It never changes which answer wins. Nothing in this module reorders candidates, filters them, or
 *   touches a coordinate — it reads a ranked list and appends an advisory. That is the whole posture:
 *   the answer is what it always was, and the result now says how sure the ranking was.
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
 * The subset of a resolver `ResolvedPlace` this module reads.
 * Structural on purpose — `AddressNode.alternatives` is `ReadonlyArray<unknown>`
 * in the decoder interface, so there is nothing to import.
 */
interface RankedPlaceLike {
	id?: number | string
	name?: string
	placetype?: string
	country?: string
	lat?: number
	lon?: number
	/**
	 * The candidate's prominence. On the candidate backend this is exactly `-effectiveNegRank`
	 * (`resolver-wof-sqlite/candidate-lookup.ts`), so a difference of two prominences is
	 * a log10 population margin and `DECISIVE_MARGIN_LOG10` applies to it directly.
	 *
	 * On the FTS backend it is `min(log-population, populationBoost) + proximityTerm`, which is
	 * a different unit: capped, and contaminated by proximity when a bias point was supplied.
	 * The marker is therefore backend-conditional and says so in its own evidence (`marginUnit`), rather
	 * than pretending the two are the same number. This is the same "the two backends do
	 * not share a unit" finding the 2026-08-04 resolver-score characterization recorded.
	 */
	prominence?: number
	score?: number
}

/**
 * Turn a resolver place into the shape {@linkcode dominanceMarginLog10} reads.
 * `negRank` is `-prominence` because prominence is `-negRank` on the backend that
 * defines both. the double negation is the whole conversion and it is written out
 * rather than folded so the sign is checkable.
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
		// absent rather than an extent of zero — this model never reads a bbox for the margin,
		// and inventing one would be a number nobody measured.
		bbox: null,
		negRank: -prominence,
		population: null,
	}
}

/**
 * The node whose resolution the query is about — the deepest resolved node carrying a coordinate
 * and the resolver's name stamp, matching `extractGeocodeResult`'s own `primaryNode` selection
 * so the marker and the returned candidate list describe the same place.
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
	 * The full kind verdict — top kind plus alternatives.
	 * `bare_toponym` is an alternative by design (see `@mailwoman/kind-classifier`'s `intent-rules.ts`),
	 * so a caller that passes only the top kind will never see this marker fire,
	 * which is a silent no-op rather than an error.
	 */
	kinds: ReadonlyArray<QueryKind>
	tree: AddressTree
	lat: number | null
	lon: number | null
}

/**
 * Raise `declared_ambiguity` when the query named one bare place and the gazetteer's
 * answer for that name is not decisive.
 *
 * Returns `null` — not an empty marker — when the query was not a bare toponym,
 * when nothing resolved, or when the margin cleared the threshold.
 * A magnitude never carries its own absence, and "we checked and it was decisive" is
 * represented by the caller's marker array simply not gaining an entry.
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

	// Fewer than two rankable candidates is not "decisive" and not "ambiguous" — it is unmeasured.
	// The resolver may simply not have stamped a prominence (the FTS path does not always),
	// and asserting decisiveness off a list of one that we could not rank would be
	// exactly the meaning-of-zero error this repo keeps writing down.
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
			/**
			 * Named so a consumer knows what the margin is. `log10_population` on the candidate
			 * backend. on FTS the prominence term is capped and proximity-contaminated,
			 * which the value states rather than hides.
			 */
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
 * The coarsest tier at which each parsed component is still located, ranked by {@linkcode tierRank}.
 *
 * A component sets a floor rather than a target. `house_number` reads `interpolated`
 * and not `address_point` because interpolation is how a house number is placed along a
 * segment — the first version of this table put the floor at `address_point` and fired on
 * `129 E Burr Oak St, Athens, MI`, an interpolated answer at 124 m uncertainty that locates
 * the house as precisely as the tier permits. `postcode` reads `street` for the same reason
 * from the other side: a postcode centroid is a street-grade answer in most address systems,
 * and a finer floor would raise this marker on every correct Dutch result.
 *
 * `unit` is deliberately absent. No layer in this repository locates a unit — there is
 * no floor or interior geometry in the artifact set — so a unit can never be "used",
 * and a floor for it would fire on every correct answer carrying one.
 *
 * The rank comes from `ablation/scoring.ts` rather than a second ladder declared here.
 * That module already orders the tiers for the deletion scorer, and two orders would let this marker
 * and the ablation runner disagree about whether an interpolated answer is a drop from an address point.
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
	 * The full kind verdict — top kind plus alternatives.
	 * The marker names the top kind, since a structured address that fell short is still a structured address.
	 */
	kinds: ReadonlyArray<QueryKind>
	/**
	 * The parsed components, by tag. Read for presence only. the values never enter the verdict.
	 */
	components: Readonly<Record<string, string | null | undefined>>
	reachedTier: ResolutionTier
}

/**
 * Raise `declared_coarser_answer` when the query supplied components finer than the tier the answer reached.
 *
 * The counterpart of {@linkcode declaredAmbiguityMarker} and written because its absence was a real silence: `301
 * College Ave #101, Athens, GA 30601` returned the Athens label centroid at `admin`, 1,627 m from the rooftop the same
 * address without `#101` reaches at `address_point`, and the response carried no field distinguishing it from a correct
 * answer to `Athens, GA`.
 *
 * Returns `null` — never an empty marker — when nothing finer was asked for and
 * when the tier met the ask. "We checked and the answer was as fine as the question"
 * is the caller's marker array not gaining an entry.
 */
export function coarserAnswerMarker(opts: CoarserAnswerOpts): QueryIntentMarker | null {
	// `venue` and `plus_code` rank as house-grade in `tierRank`, so an entity answer
	// and a decoded plus code satisfy every floor here and raise nothing — which is correct:
	// a resolved venue is the place the query asked about.
	const reached = tierRank(opts.reachedTier)

	const unused = COMPONENT_TIER_FLOOR.filter(([tag, floor]) => opts.components[tag] && reached < tierRank(floor))

	if (!unused.length) return null

	// The finest floor any unused component sets — what the answer would have had to reach to use all of them.
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
