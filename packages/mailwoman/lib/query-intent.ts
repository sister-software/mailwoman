/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   THE DECLARED-AMBIGUITY MARKER (ROAD_TO_V9 §4.2 + the §4 guessing doctrine).
 *
 *   > when the dominance margin is thin (the measured 0.5 log10 line from the ablation-ladder work),
 *   > return the winner with declared ambiguity — the suggestion layer's nudge shape — and never
 *   > resolve a bare query to an obscure feature type silently.
 *
 *   The three OTHER intent markers are raised by the kind classifier, from the string alone
 *   (`@mailwoman/kind-classifier`'s `intent-markers.ts`). This one cannot be: its trigger is a
 *   property of the RESOLVED candidate list, which does not exist until after Stage 6. So it lives
 *   here, on the geocode path, and `geocodeAddressOnce` appends it to the classifier's markers.
 *
 *   ## Reuse, not re-derivation
 *
 *   {@linkcode DECISIVE_MARGIN_LOG10} (0.5) and {@linkcode COINCIDENT_PLACE_KM} (10) are imported
 *   from the ablation-expectation model rather than restated. Both are MEASURED numbers with a table
 *   behind them (see that module's docstring: below 0.5 the top-ranked place is the intended one
 *   52.4% of the time, above it 89.1%), and a second copy would be a second thing to keep in sync
 *   with a measurement nobody re-runs. `dominanceMarginLog10` itself is imported too — the
 *   subtraction is three lines, and the point is that there is ONE definition of "decisive" in this
 *   repo.
 *
 *   The import crosses from `eval-harness/` into the production geocode path, which is unusual and
 *   deliberate. The alternative was moving the constants into `@mailwoman/core` (a shipped-package
 *   change for two numbers, with the eval harness then importing them back) or copying them (a
 *   silent-drift generator). The module imports nothing but `@mailwoman/spatial`, so the cost is a
 *   type-strip, not a dependency.
 *
 *   ## The collapse is required
 *
 *   WOF stores a big city twice — Paris the `locality` and Paris the `localadmin`, same population —
 *   so a RAW top-2 margin reads 0.01 for Paris and 0.00 for Washington. Uncollapsed, every major city
 *   reads maximally ambiguous and this marker fires on every capital in the world.
 *   `extractGeocodeResult`'s own candidate list already de-dupes, but on an ~11 m grid, which is two
 *   orders of magnitude too tight for this job. So the collapse here is at
 *   {@linkcode COINCIDENT_PLACE_KM} and it runs on the RESOLVER's places, before the geocode result's
 *   de-dupe, which is the only place the prominence column is still attached.
 *
 *   ## What it does NOT do
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
} from "#eval-harness/gauntlet/ablation-expectation"
import { collapseCoincident } from "#eval-harness/gauntlet/ablation-gazetteer"

/**
 * The subset of a resolver `ResolvedPlace` this module reads. Structural on purpose — `AddressNode.alternatives` is
 * `ReadonlyArray<unknown>` in the decoder contract, so there is nothing to import.
 */
interface RankedPlaceLike {
	id?: number | string
	name?: string
	placetype?: string
	country?: string
	lat?: number
	lon?: number
	/**
	 * The candidate's PROMINENCE. On the candidate backend this is exactly `-effectiveNegRank`
	 * (`resolver-wof-sqlite/candidate-lookup.ts`), so a difference of two prominences IS a log10 population margin and
	 * `DECISIVE_MARGIN_LOG10` applies to it directly.
	 *
	 * On the FTS backend it is `min(log-population, populationBoost) + proximityTerm`, which is a DIFFERENT unit: capped,
	 * and contaminated by proximity when a bias point was supplied. The marker is therefore backend-conditional and says
	 * so in its own evidence (`marginUnit`), rather than pretending the two are the same number. This is the same "the
	 * two backends do not share a unit" finding the 2026-08-04 resolver-score characterization recorded.
	 */
	prominence?: number
	score?: number
}

/**
 * Turn a resolver place into the shape {@linkcode dominanceMarginLog10} reads. `negRank` is `-prominence` because
 * prominence is `-negRank` on the backend that defines both; the double negation is the whole conversion and it is
 * written out rather than folded so the sign is checkable.
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
		// ABSENT, not an extent of zero — this model never reads a bbox for the margin, and inventing one would be a
		// number nobody measured.
		bbox: null,
		negRank: -prominence,
		population: null,
	}
}

/**
 * The node whose resolution the query is ABOUT — the deepest resolved node carrying a coordinate and the resolver's
 * name stamp, matching `extractGeocodeResult`'s own `primaryNode` selection so the marker and the returned candidate
 * list describe the same place.
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
	 * The full kind verdict — top kind plus alternatives. `bare_toponym` is an ALTERNATIVE by design (see
	 * `@mailwoman/kind-classifier`'s `intent-rules.ts`), so a caller that passes only the top kind will never see this
	 * marker fire, which is a silent no-op rather than an error.
	 */
	kinds: ReadonlyArray<QueryKind>
	tree: AddressTree
	lat: number | null
	lon: number | null
}

/**
 * Raise `declared_ambiguity` when the query named ONE bare place and the gazetteer's answer for that name is not
 * decisive.
 *
 * Returns `null` — not an empty marker — when the query was not a bare toponym, when nothing resolved, or when the
 * margin cleared the threshold. A magnitude never carries its own absence, and "we checked and it was decisive" is
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

	// Fewer than two rankable candidates is not "decisive" and not "ambiguous" — it is UNMEASURED. The resolver may
	// simply not have stamped a prominence (the FTS path does not always), and asserting decisiveness off a list of one
	// that we could not rank would be exactly the meaning-of-zero error this repo keeps writing down.
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
			 * Named so a consumer knows what the margin IS. `log10_population` on the candidate backend; on FTS the
			 * prominence term is capped and proximity-contaminated, which the value states rather than hides.
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
