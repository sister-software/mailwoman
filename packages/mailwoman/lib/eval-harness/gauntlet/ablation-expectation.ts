/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Graceful-degradation expectation model for gauntlet component ablations.
 *
 * Builds a non-circular resolution ladder from the asserted coordinate, derives the honest rung from only the evidence
 * remaining after deletion, and grades from the undeleted answer’s achieved rung. Every rung carries an explicit radius;
 * ambiguous names abstain. See `ablation-expectation.md` for the design, measurements, and threshold rationale.
 */

import { haversineKm } from "@mailwoman/spatial"

import type { AblationGrade } from "#eval-harness/gauntlet/ablation-grades"

/**
 * A place as this model needs it: a centroid, a placetype, and either a real bbox or an honest `null`.
 */
export interface AblationPlace {
	id: number
	name: string
	placetype: string
	/**
	 * ISO-3166 alpha-2.
	 */
	country: string
	lat: number
	lon: number
	/**
	 * `null` when the gazetteer row's bbox is degenerate (`min == max`) — ABSENT, never an extent of zero. See the module
	 * docstring for how often that is (49.2% of localities).
	 */
	bbox: { minLat: number; maxLat: number; minLon: number; maxLon: number } | null
	/**
	 * `-log10(population + 1)`, the column the gazetteer ranks by (ascending = most populous first). Present on every
	 * candidate row; `population` itself is frequently unknown, which is why the margin is taken on this.
	 */
	negRank: number
	population: number | null
}

/**
 * Where a rung's radius came from. Recorded per rung so the artifact can be re-graded against different numbers without
 * re-running the pipeline — and so a reader can tell a measured extent from a placetype prior.
 */
export type RungRadiusSource = "row-tolerance" | "bbox" | "placetype-floor"

/**
 * One rung of the ladder: a disc the answer may honestly land in, and how far down the ladder it is.
 */
export interface AblationRung {
	/**
	 * 0 = the undeleted case's own answer; higher = coarser.
	 */
	depth: number
	/**
	 * `base` for rung 0, else the WOF placetype (`locality`, `county`, `region`, `country`, …).
	 */
	kind: string
	name: string
	/**
	 * WOF id, or `null` for rung 0 (the anchor coordinate is not a gazetteer place).
	 */
	placeID: number | null
	lat: number
	lon: number
	radiusKM: number
	radiusSource: RungRadiusSource
}

/**
 * A rung the ancestry could not support, and why. Reported rather than dropped: a short ladder and a complete one must
 * never look the same, exactly as a zero-support cell and an unmeasured one must not.
 */
export interface AblationLadderGap {
	placetype: string
	name: string
	reason: string
}

/**
 * The ladder for one corpus row: rung 0 (its own answer) then its ancestry, deepest first.
 */
export interface AblationLadder {
	rungs: AblationRung[]
	gaps: AblationLadderGap[]
}

/**
 * The sentinel depth meaning "no coordinate is honest here". Not a rung with a huge radius — a huge radius would still
 * PASS a confident wrong answer, and the whole point of this rung is that answering at all is the defect.
 */
export const ABSTAIN_RUNG = "abstain" as const

/**
 * What {@linkcode deriveExpectedRung} concluded, with the reason attached. The reason is data: it is how a reader tells
 * "the postcode still pinned it" from "the name was decisive" from "nothing survived".
 */
export type ExpectedRung =
	| { kind: "rung"; depth: number; why: string }
	| { kind: typeof ABSTAIN_RUNG; why: string; homonymTakeover?: boolean }
	| { kind: typeof UNCONSTRAINED_RUNG; why: string }

/**
 * The expectation for a variant whose surviving evidence includes a handle THIS MODEL CANNOT EVALUATE — a venue name
 * (POI resolution lives in `poi.db`, build-local and not a dependency of this layer) or a street name (no street index
 * here). Any rung, including abstention, passes; only leaving the ladder entirely fails.
 *
 * It exists because the alternative is a confident wrong expectation. `Daniel's Head Beach Park, Scotts Hill` survives
 * a country deletion: `Scotts Hill` alone is a 3-way tie whose top-ranked place is in Austria, so the name cascade
 * would demand abstention — and the pipeline correctly answers Bermuda, off the venue. Declining to constrain that row
 * is honest; demanding abstention would have scored a correct answer as overconfident.
 *
 * It is NOT a free pass. The Springfield case keeps its teeth: `742 Evergreen Terrace, Springfield` may answer anywhere
 * on the Springfield-IL ladder or abstain, and answering Springfield MA — 428 km away, off the ladder — is still
 * `wrong`.
 */
export const UNCONSTRAINED_RUNG = "unconstrained" as const

export {
	ABLATION_GRADES,
	type AblationGrade,
	emptyGrades,
	PASSING_GRADES,
} from "#eval-harness/gauntlet/ablation-grades"

/**
 * Placetype → fallback rung radius (km): that placetype's MEASURED p90 bbox radius in `admin-global-priority.db`
 * (2026-08-05; sampled `is_current = 1` rows carrying a non-degenerate bbox, every table under 50k rows scanned whole
 * and the rest sampled `id % 97`).
 *
 * | placetype     | rows      | degenerate bbox | p50 km | p90 km  |
 * | ------------- | --------: | --------------: | -----: | ------: |
 * | country       | 237       | 59.1%           | 808.91 | 2613.77 |
 * | macroregion   | 65        | 0.0%            | 165.33 | 306.03  |
 * | region        | 4,299     | 39.3%           | 93.66  | 374.17  |
 * | macrocounty   | 467       | 0.0%            | 44.85  | 70.04   |
 * | county        | 36,532    | 0.6%            | 22.74  | 75.33   |
 * | localadmin    | 112,039   | 2.7%            | 4.77   | 11.55   |
 * | locality      | 4,363,942 | 49.2%           | 0.62   | 5.95    |
 * | borough       | 289       | 0.0%            | 4.37   | 10.45   |
 * | macrohood     | 994       | 0.2%            | 1.78   | 4.87    |
 * | neighbourhood | 348,323   | 86.2%           | 0.57   | 2.44    |
 * | microhood     | 1,696     | 8.0%            | 0.69   | 1.76    |
 *
 * P90 rather than p50 on purpose: the floor decides whether a CORRECT coarsening passes, and a p50 disc would fail an
 * answer that landed at the far edge of a bigger-than-median city. A placetype absent from this table has no floor, and
 * a rung whose bbox is also degenerate is DROPPED into {@linkcode AblationLadder.gaps} rather than given a guessed
 * radius.
 */
export const RUNG_RADIUS_FLOOR_KM: Readonly<Record<string, number>> = {
	country: 2614,
	macroregion: 306,
	region: 374,
	macrocounty: 70,
	county: 75,
	localadmin: 12,
	locality: 6,
	borough: 10,
	macrohood: 5,
	neighbourhood: 2.5,
	microhood: 2,
}

/**
 * Two candidates closer than this are the SAME physical place, not namesakes — WOF stores a big city as both a
 * `locality` and a `localadmin`, at the same population. Collapsing them is a precondition of
 * {@linkcode DECISIVE_MARGIN_LOG10} meaning anything (see the module docstring: uncollapsed, Paris reads a 0.01
 * margin).
 */
export const COINCIDENT_PLACE_KM = 10

/**
 * The log10 population margin at which a name is DECISIVE. Measured — see the module docstring's table: below 0.5 the
 * top-ranked place is the intended one 52.4% of the time (a coin flip), above it 89.1%.
 */
export const DECISIVE_MARGIN_LOG10 = 0.5

/**
 * A bbox is treated as ABSENT below this extent: `spr` stores an unset bbox as `min == max`, and even non-degenerate
 * rows are frequently a sub-100 m rounding artifact (12,881 of 22,780 sampled localities). 0.1 km is that noise floor.
 */
const BBOX_NOISE_FLOOR_KM = 0.1

/**
 * The placetypes a locality-ish name may resolve to. Deliberately excludes `country`/`region` (those are queried
 * explicitly, by their own component) and `postalcode` (queried by the postcode component).
 */
export const LOCALITY_PLACETYPES = [
	"locality",
	"localadmin",
	"borough",
	"county",
	"macrohood",
	"neighbourhood",
	"microhood",
] as const

/**
 * WOF containment depth, coarsest = 1 — the same ordering `resolver-wof-sqlite/ancestry.ts` publishes as
 * `PLACETYPE_DEPTH`. Duplicated deliberately rather than imported: this module must rank a placetype string coming off
 * an ARTIFACT (an old ablation run being re-graded), where the resolver's table may have moved on. `0` = unknown, which
 * sorts coarsest.
 */
const PLACETYPE_CONTAINMENT_DEPTH: Readonly<Record<string, number>> = {
	country: 1,
	macroregion: 2,
	region: 3,
	macrocounty: 4,
	county: 5,
	localadmin: 6,
	locality: 7,
	borough: 8,
	macrohood: 9,
	neighbourhood: 10,
	microhood: 11,
	// FINER than any admin grain on purpose. A postcode is a point-grade pin, and `matchRung` refuses to match a pin
	// against a rung finer than itself — with `postalcode` at the unknown-placetype 0, a surviving postcode pinned
	// NOTHING and every postcode-bearing variant read as a homonym takeover. Caught by the "holds the rooftop when a
	// postcode and the street evidence both survive" test, which is the case the whole layer is about.
	postalcode: 12,
}

/**
 * Containment depth for a placetype — higher is finer, 0 when unknown (sorts coarsest). Mirrors `resolver-wof-sqlite`'s
 * `placetypeDepth`; see {@linkcode PLACETYPE_CONTAINMENT_DEPTH} for why it is not imported.
 */
export function containmentDepth(placetype: string): number {
	return PLACETYPE_CONTAINMENT_DEPTH[placetype] ?? 0
}

/**
 * The radius a bbox implies: the furthest of its four corners from the centroid. `null` when the bbox is absent,
 * degenerate, or below the noise floor — all three of which are "this place has no recorded extent", never "this place
 * has no extent".
 */
export function bboxRadiusKm(place: Pick<AblationPlace, "lat" | "lon" | "bbox">): number | null {
	const b = place.bbox

	if (!b) return null

	if (b.minLat === b.maxLat && b.minLon === b.maxLon) return null

	const corners: Array<[number, number]> = [
		[b.minLat, b.minLon],
		[b.minLat, b.maxLon],
		[b.maxLat, b.minLon],
		[b.maxLat, b.maxLon],
	]

	const km = Math.max(...corners.map(([lat, lon]) => haversineKm(place.lat, place.lon, lat, lon)))

	return km < BBOX_NOISE_FLOOR_KM ? null : km
}

/**
 * The radius for one ancestry rung, and where it came from. `null` = this place cannot carry a rung (no usable bbox AND
 * no floor for its placetype) — the caller records the gap instead of inventing a number.
 */
export function rungRadiusKm(place: AblationPlace): { radiusKM: number; radiusSource: RungRadiusSource } | null {
	const measured = bboxRadiusKm(place)
	const floor = RUNG_RADIUS_FLOOR_KM[place.placetype]

	if (measured != null && (floor === undefined || measured >= floor)) {
		return { radiusKM: measured, radiusSource: "bbox" }
	}

	if (floor === undefined) return null

	return { radiusKM: floor, radiusSource: "placetype-floor" }
}

/**
 * Build the ladder from the anchor's answer plus its resolved place chain (deepest place first, then its ancestors).
 *
 * Two rules earn their keep here:
 *
 * - **Radii are made monotonic going up.** A locality with a real 30 km bbox inside a county whose bbox is degenerate
 *   (floor 75 km) is fine, but the reverse happens too — an ancestor whose recorded extent is TIGHTER than its child's,
 *   which would make a correct coarsening fail at the coarser rung and pass at the finer one. The running max removes
 *   that, and the pre-max value stays visible via `radiusSource`.
 * - **A place with no usable radius is dropped, loudly.** It becomes an {@linkcode AblationLadderGap}, so a two-rung
 *   ladder is attributable to the gazetteer rather than read as "this address has no ancestry".
 */
export function ablationLadderFromChain(
	anchor: { lat: number; lon: number },
	chain: readonly AblationPlace[],
	toleranceKm: number
): AblationLadder {
	const rungs: AblationRung[] = [
		{
			depth: 0,
			kind: "base",
			name: "(the row's own answer)",
			placeID: null,
			lat: anchor.lat,
			lon: anchor.lon,
			radiusKM: toleranceKm,
			radiusSource: "row-tolerance",
		},
	]

	const gaps: AblationLadderGap[] = []
	let runningMax = toleranceKm

	for (const place of chain) {
		const radius = rungRadiusKm(place)

		if (!radius) {
			gaps.push({
				placetype: place.placetype,
				name: place.name,
				reason: `no usable bbox (degenerate or sub-${BBOX_NOISE_FLOOR_KM} km) and no floor for placetype "${place.placetype}"`,
			})

			continue
		}

		runningMax = Math.max(runningMax, radius.radiusKM)

		rungs.push({
			depth: rungs.length,
			kind: place.placetype,
			name: place.name,
			placeID: place.id,
			lat: place.lat,
			lon: place.lon,
			radiusKM: runningMax,
			radiusSource: radius.radiusSource,
		})
	}

	return { rungs, gaps }
}

/**
 * The gazetteer probes this model needs. An interface, not a class, for one reason: {@linkcode deriveExpectedRung} is
 * the piece that must be provably non-circular, and it can only be TESTED that way against a fake.
 */
export interface AblationGazetteerProbe {
	/**
	 * The place a WOF id names, or `null` when the ancestry DB does not carry it.
	 */
	place(id: number): AblationPlace | null
	/**
	 * `id`'s containment chain, nearest-first, self excluded.
	 */
	lineage(id: number): AblationPlace[]
	/**
	 * The admin chain CONTAINING a coordinate, deepest first — a reverse geocode. This is what the ladder is built from,
	 * and it is why the ladder owes nothing to the pipeline: the chain follows from the corpus's own asserted coordinate,
	 * not from what the parser did with the address.
	 */
	containingChain(lat: number, lon: number): AblationPlace[]
	/**
	 * Distinct places sharing a name, most-populous-first, coincident twins already collapsed.
	 */
	named(name: string, opts?: { country?: string; placetypes?: readonly string[] }): AblationPlace[]
}

/**
 * The log10 population margin between a candidate list's top two DISTINCT places. `Infinity` for a single candidate (no
 * contest), 0 for an empty one.
 */
export function dominanceMarginLog10(places: readonly AblationPlace[]): number {
	if (!places.length) return 0

	if (places.length === 1) return Infinity

	return places[1]!.negRank - places[0]!.negRank
}

/**
 * Is the top candidate decisive — one place, or a population margin at or above the measured cut?
 */
export function isDecisive(places: readonly AblationPlace[]): boolean {
	return places.length > 0 && dominanceMarginLog10(places) >= DECISIVE_MARGIN_LOG10
}

/**
 * A per-case hand-pin, for the rows where the derived ladder is wrong.
 *
 * Keyed by the deleted component; the value is `"abstain"`, `"base"`, or a WOF placetype naming the rung the deletion
 * should degrade to (`"region"`, `"country"`, …). Absent component = the derived ladder decides, which is the default
 * and should stay the common case: a corpus full of hand-pins is a model nobody can trust.
 *
 * It exists because two classes of place defeat the derivation and no threshold fixes them: TERRITORIES, whose ancestry
 * chain is politically rather than geographically shaped (a Puerto Rico row's `country` rung is the US, 5,500 km of
 * disc), and DUAL-ROLE places (#402), where the same name is both a locality and its own county and the ladder
 * double-counts a rung.
 *
 * WHAT IT CANNOT DO: supply a ladder. A pin names a rung ON the derived ladder, so a row whose ladder could not be
 * built at all — no asserted coordinate, no containing place, a containment country contradicting the corpus — stays
 * `ungraded` however it is pinned. Those rows need a coordinate in the corpus or a gazetteer fix, not a pin.
 */
export type AblationExpectOverride = Record<string, string>

/**
 * Resolve a hand-pin against a ladder. Returns `null` when the pin names a rung this ladder does not have — a pin that
 * cannot be honoured must not silently fall back to the derived answer under the pin's name.
 */
export function overrideToExpectedRung(pin: string, ladder: AblationLadder): ExpectedRung | null {
	if (pin === ABSTAIN_RUNG) return { kind: ABSTAIN_RUNG, why: "per-case override" }

	const rung = ladder.rungs.find((r) => r.kind === pin)

	return rung ? { kind: "rung", depth: rung.depth, why: `per-case override → ${pin}` } : null
}

/**
 * The evidence a variant still carries: the case's asserted components MINUS the one that was deleted.
 */
export type RemainingComponents = Readonly<Record<string, string>>

/**
 * The deepest rung the REMAINING components still pin — the normative expectation for one deletion variant.
 *
 * Takes no result argument, by construction: see the module docstring. Everything it reads is either the surviving
 * components, the ladder (built from the UNDELETED case), or the gazetteer.
 */
export function deriveExpectedRung(
	remaining: RemainingComponents,
	ladder: AblationLadder,
	gz: AblationGazetteerProbe,
	/**
	 * Words left in the ablated input that no surviving component accounts for ({@linkcode residualWords}). Untyped
	 * evidence: it can only stop an ABSTAIN expectation, never deepen a rung one.
	 */
	residual: readonly string[] = []
): ExpectedRung {
	const countryName = remaining["country"]?.trim()
	const regionName = remaining["region"]?.trim()
	const postcode = remaining["postcode"]?.trim()
	const localityName = (remaining["locality"] ?? remaining["dependent_locality"])?.trim()

	// The country component narrows every later probe. A country name that resolves to nothing (an abbreviation the
	// gazetteer does not carry) leaves the constraint unset rather than filtering everything out.
	const countryPlace = countryName ? (gz.named(countryName, { placetypes: ["country"] })[0] ?? null) : null
	const countryCode = countryPlace?.country || undefined

	const regionPlace = regionName
		? (gz.named(regionName, {
				placetypes: ["region", "macroregion"],
				...(countryCode ? { country: countryCode } : {}),
			})[0] ?? null)
		: null

	// A surviving REGION narrows the namesake field, and it has to do so by RADIUS rather than by bbox: 39.3% of WOF
	// regions carry a degenerate bbox, so a bbox filter would quietly stop constraining on two regions in five. The
	// radius is the region's own rung radius — the same measured floor the ladder is built from.
	const regionRadiusKm = regionPlace ? (rungRadiusKm(regionPlace)?.radiusKM ?? null) : null

	const withinRegion = (places: readonly AblationPlace[]): AblationPlace[] =>
		regionPlace && regionRadiusKm != null
			? places.filter((p) => haversineKm(regionPlace.lat, regionPlace.lon, p.lat, p.lon) <= regionRadiusKm)
			: [...places]

	// 1. A postcode that resolves to exactly one place is the strongest surviving pin there is.
	const postcodePlaces = postcode
		? withinRegion(gz.named(postcode, { placetypes: ["postalcode"], ...(countryCode ? { country: countryCode } : {}) }))
		: []

	const localityPlaces = localityName
		? withinRegion(
				gz.named(localityName, { placetypes: LOCALITY_PLACETYPES, ...(countryCode ? { country: countryCode } : {}) })
			)
		: []

	// Evidence this model cannot evaluate. Three kinds, one consequence — it may not demand abstention:
	//
	//  - No index here. A venue resolves from `poi.db` (build-local, not a dependency of this layer) and a street from
	//    the address-point / street-centroid databases.
	//  - A constraint that did not resolve. `cr-op3-san-jose` asserts the region as "San José Province" and WOF calls it
	//    "San José", so the region lookup misses; the surviving region is real evidence the pipeline will use, and
	//    demanding abstention because THIS model could not look it up would be scoring the model's gap as the parser's.
	//  - Untyped words the corpus never asserted (`residualWords`) — the row said less than its input carries.
	const unevaluable = [
		remaining["venue"]?.trim(),
		remaining["street"]?.trim(),
		regionName && !regionPlace ? `region "${regionName}" (unresolved)` : undefined,
		countryName && !countryPlace ? `country "${countryName}" (unresolved)` : undefined,
		// Untyped words still in the input. Third kind, same consequence — see `residualWords`.
		residual.length ? `${residual.length} untyped input word(s) (${residual.slice(0, 3).join(", ")})` : undefined,
	].filter((entry) => entry != null && entry.length > 0)

	const declineToConstrain = (why: string): ExpectedRung => ({
		kind: UNCONSTRAINED_RUNG,
		why: `${why}, but ${unevaluable.map((v) => `"${v}"`).join(" + ")} survives — this model cannot evaluate it`,
	})

	let pinned: AblationPlace | null = null
	let why = ""

	if (postcodePlaces.length === 1) {
		pinned = postcodePlaces[0]!
		why = `postcode "${postcode}" resolves to exactly one place`
	} else if (localityPlaces.length) {
		const margin = dominanceMarginLog10(localityPlaces)

		if (isDecisive(localityPlaces)) {
			pinned = localityPlaces[0]!

			why =
				localityPlaces.length === 1
					? `"${localityName}" is the only place of that name under the surviving evidence`
					: `"${localityName}" wins its ${localityPlaces.length}-way namesake contest by ${margin.toFixed(2)} log10 population`
		} else if (postcodePlaces.length) {
			// An ambiguous postcode still disambiguates an ambiguous name: keep the namesake nearest a postcode
			// point. This is the (postcode, locality) coherence #42 exploits, used here only as EVIDENCE.
			const near = localityPlaces
				.map((p) => ({
					p,
					km: Math.min(...postcodePlaces.map((q) => haversineKm(p.lat, p.lon, q.lat, q.lon))),
				}))
				.toSorted((a, b) => a.km - b.km)[0]

			if (near && near.km <= (RUNG_RADIUS_FLOOR_KM["county"] ?? 75)) {
				pinned = near.p
				why = `"${localityName}" is ${margin.toFixed(2)} log10 ambiguous but coherent with postcode "${postcode}" (${near.km.toFixed(1)} km)`
			}
		}

		if (!pinned) {
			const ambiguous = `"${localityName}" names ${localityPlaces.length} distinct places and the top-2 population margin is ${margin.toFixed(2)} < ${DECISIVE_MARGIN_LOG10}`

			return unevaluable.length ? declineToConstrain(ambiguous) : { kind: ABSTAIN_RUNG, why: ambiguous }
		}
	} else if (regionPlace) {
		pinned = regionPlace
		why = `only the region "${regionName}" survives`
	} else if (countryPlace) {
		pinned = countryPlace
		why = `only the country "${countryName}" survives`
	}

	if (!pinned) {
		const nothing = localityName
			? `"${localityName}" resolves to no place under the surviving evidence`
			: "no surviving component names a place"

		return unevaluable.length ? declineToConstrain(nothing) : { kind: ABSTAIN_RUNG, why: nothing }
	}

	const rung = matchRung(pinned, ladder)

	if (!rung) {
		const takeover = `${why}, but that is ${pinned.name} (${pinned.country}) — not on this row's ladder`

		// A takeover with street/venue evidence still standing is not a settled expectation: the street may pull the
		// answer back onto the ladder (`8 Rue X, Paris` after `TX` goes). Decline rather than demand abstention.
		return unevaluable.length
			? declineToConstrain(takeover)
			: { kind: ABSTAIN_RUNG, why: takeover, homonymTakeover: true }
	}

	// The rooftop only stays REQUIRED while the street evidence survives alongside the deepest admin pin.
	const streetEvidence =
		(!!remaining["street"]?.trim() && !!remaining["house_number"]?.trim()) || !!remaining["venue"]?.trim()

	const deepestAdmin = ladder.rungs.length > 1 ? ladder.rungs[1]! : null

	if (streetEvidence && deepestAdmin && rung.depth === deepestAdmin.depth) {
		return { kind: "rung", depth: 0, why: `${why}, and the street evidence survived — the rooftop must hold` }
	}

	return { kind: "rung", depth: rung.depth, why }
}

/**
 * Does this ladder describe the address the corpus row actually asserts?
 *
 * Returns a reason when it does NOT, `null` when it does. Only rows that assert no coordinate can fail it — theirs is
 * the ladder built on the pipeline's own undeleted answer, and 342 of the 667 variants in the 2026-08-05 corpus come
 * from such rows (72 of 192 cases). When that answer is in the wrong place, the ladder is drawn around the wrong town
 * and every verdict on it is noise wearing a component's name: `gb-op2-east-west-kingsland` asserts London and its
 * undeleted answer resolved elsewhere in the UK, so the expectation for EVERY one of its deletions collapsed to
 * "country" — the only rung the two places share.
 *
 * The test: derive the expectation from the FULL component set (nothing deleted). If the row names a place finer than a
 * region and the ladder can only match it at `macroregion` / `country` grain, the ladder and the row's own components
 * disagree about which city this is. The check reads components and the gazetteer, never the ablated output.
 */
export function ladderComponentDisagreement(
	components: RemainingComponents,
	ladder: AblationLadder,
	gz: AblationGazetteerProbe
): string | null {
	// Only a row that names a city-or-finer place can be checked; one that names only a country has nothing to
	// disagree about.
	const namesFinePlace = Boolean(
		components["locality"]?.trim() || components["dependent_locality"]?.trim() || components["postcode"]?.trim()
	)

	if (!namesFinePlace) return null

	const undeleted = deriveExpectedRung(components, ladder, gz)

	if (undeleted.kind === ABSTAIN_RUNG) {
		return undeleted.homonymTakeover
			? `the row's own components point at a place that is not on this ladder (${undeleted.why})`
			: null
	}

	if (undeleted.kind === UNCONSTRAINED_RUNG) return null

	const rung = ladder.rungs[undeleted.depth]

	if (!rung || containmentDepth(rung.kind) >= REGION_GRAIN_DEPTH || rung.depth === 0) return null

	return (
		`the row's own components only match this ladder at "${rung.kind}" grain — the ladder is drawn around a ` +
		`different place than the row asserts (${undeleted.why})`
	)
}

/**
 * The containment depth of a `region`. A row that names a city and can only be matched to its ladder at a grain COARSER
 * than this is a row whose ladder is about somewhere else.
 */
const REGION_GRAIN_DEPTH = 3

/**
 * The ladder rung a pinned place corresponds to: the same WOF id, else the deepest rung whose disc contains it and
 * whose placetype is no FINER than the pin's (a country pin must not match the locality rung merely by sitting inside
 * it). `null` = the pin is off this ladder — a homonym takeover.
 */
export function matchRung(pinned: AblationPlace, ladder: AblationLadder): AblationRung | null {
	const byID = ladder.rungs.find((r) => r.placeID != null && r.placeID === pinned.id)

	if (byID) return byID

	const pinDepth = containmentDepth(pinned.placetype)

	for (const rung of ladder.rungs) {
		if (rung.depth === 0) continue

		if (containmentDepth(rung.kind) > pinDepth) continue

		if (haversineKm(rung.lat, rung.lon, pinned.lat, pinned.lon) <= rung.radiusKM) return rung
	}

	return null
}

/**
 * The deepest rung whose disc contains a point, or `null` when the point is outside every rung — the answer left the
 * ladder entirely (the `Ave` → a French locality class).
 */
export function achievedRung(lat: number, lon: number, ladder: AblationLadder): AblationRung | null {
	for (const rung of ladder.rungs) {
		if (haversineKm(rung.lat, rung.lon, lat, lon) <= rung.radiusKM) return rung
	}

	return null
}

/**
 * Grade one variant against its expected rung.
 *
 * SUBSTITUTION IS A HARD FAIL AT EVERY RUNG, checked first and independent of geometry: a slot refilled by a different
 * token (S-2's finding 3 — a house number emitted as the postcode) makes a completion nudge unsafe no matter how good
 * the coordinate is, and letting a coarsening pass would hide exactly the rows the map exists to surface. The achieved
 * depth is still recorded, so a substitution's geometry stays readable.
 */
export function gradeAgainstLadder(input: {
	expected: ExpectedRung
	ladder: AblationLadder
	lat: number | null
	lon: number | null
	/**
	 * The deleted component's slot outcome (`substituted` is the hard fail).
	 */
	slot: "absent" | "recovered" | "substituted"
	/**
	 * The rung the UNDELETED case reached — the floor a deletion is judged from.
	 *
	 * This layer asks what the DELETION cost, and a row whose undeleted answer already sits at the locality rung cannot
	 * be made to lose a rooftop it never had. Without the floor, `ca-op3-lakehead-university` charged its component
	 * ledger seven failures for a case that was already resolving to the Thunder Bay centroid before anything was deleted
	 * — every variant displaced 0.00 km from the anchor and still graded as a loss.
	 *
	 * `null` means the undeleted answer is not on its own ladder at all, and nothing about the deletion can be read off a
	 * row like that: the verdict is `ungraded`.
	 */
	anchorRungDepth: number | null
}): { grade: AblationGrade; achievedRungDepth: number | null; degradedRungs: number | null } {
	const { expected, ladder, lat, lon, slot, anchorRungDepth } = input
	const resolved = lat != null && lon != null
	const achieved = resolved ? achievedRung(lat, lon, ladder) : null
	const achievedRungDepth = achieved?.depth ?? null

	if (anchorRungDepth == null) {
		return { grade: "ungraded", achievedRungDepth, degradedRungs: null }
	}

	// The cost of the DELETION: rungs lost relative to where the undeleted case already stood, never relative to a
	// rooftop the row never reached. Floored at 0 so a variant that lands FINER than its own anchor reads as no loss.
	const fell = achievedRungDepth == null ? null : Math.max(0, achievedRungDepth - anchorRungDepth)

	if (slot === "substituted") {
		return { grade: "substituted", achievedRungDepth, degradedRungs: fell }
	}

	if (expected.kind === ABSTAIN_RUNG) {
		if (!resolved) return { grade: "correctlyAbstained", achievedRungDepth: null, degradedRungs: null }

		return {
			grade: expected.homonymTakeover ? "homonymTakeover" : "overconfident",
			achievedRungDepth,
			degradedRungs: fell,
		}
	}

	if (expected.kind === UNCONSTRAINED_RUNG) {
		// Abstention is as acceptable as any rung when the model declined to constrain — claiming otherwise would be
		// claiming to know what the venue/street index would have found.
		if (!resolved) return { grade: "correctlyAbstained", achievedRungDepth: null, degradedRungs: null }

		if (achieved == null) return { grade: "wrong", achievedRungDepth: null, degradedRungs: null }

		return { grade: fell === 0 ? "held" : "degraded", achievedRungDepth, degradedRungs: fell }
	}

	if (!resolved) return { grade: "lost", achievedRungDepth: null, degradedRungs: null }

	// Off the ladder entirely (a DIFFERENT place) vs. on it but coarser than the surviving evidence justifies. Two
	// different defects: the first is resolution, the second is precision.
	if (achieved == null) return { grade: "wrong", achievedRungDepth: null, degradedRungs: null }

	// The anchor floor: a deletion cannot be charged for precision the undeleted case never had.
	if (achieved.depth > Math.max(expected.depth, anchorRungDepth)) {
		return { grade: "coarser", achievedRungDepth, degradedRungs: fell }
	}

	return { grade: fell === 0 ? "held" : "degraded", achievedRungDepth, degradedRungs: fell }
}

/**
 * The absence marker, shared by the expectation model and every renderer over it. ONE symbol for "no cell", "support 0"
 * and "no ladder" — a consumer that needs to tell those apart can still do so in the JSON, and a reader of the table
 * must not be able to mistake any of them for a score.
 */
export const ABLATION_ABSENT = "·"

/**
 * Shortest untyped word that counts as evidence in {@linkcode residualWords}. Three, because the corpus's own untyped
 * remainder is dominated by street-type particles and elisions (`de`, `du`, `la`, `st`, `nw`) that pin nothing, while
 * the words that DO carry evidence are toponyms and street names. Counting the two-letter tail would make almost every
 * variant unconstrained and hollow out the abstention class this model exists to defend.
 */
const RESIDUAL_MIN_WORD_LENGTH = 3

/**
 * Words still in the ablated INPUT that no surviving component accounts for.
 *
 * The corpus types what a case chose to assert, and most rows assert two or three tags out of an address that carries
 * six. `fr-chevaleret-rooftop` asserts `{postcode: "75013"}` and nothing else, so deleting its postcode leaves the
 * model with an empty component set — and an empty component set reads as "nothing names a place", i.e. ABSTAIN. The
 * input at that point is `181 Rue du Chevaleret, Paris`, the pipeline resolves the rooftop, and the model calls that
 * overconfident. It is the model that is wrong: there is plenty of evidence, it is just untyped.
 *
 * So untyped residual words count as evidence this model cannot evaluate ({@linkcode UNCONSTRAINED_RUNG}), exactly like
 * a venue. Tokens shorter than three characters and pure digits are ignored — a house number or a bare `de` pins
 * nothing, and treating them as evidence would make every row unconstrained.
 */
export function residualWords(ablatedInput: string, remaining: RemainingComponents): string[] {
	const accounted = new Set(
		Object.values(remaining)
			.flatMap((value) => value.toLowerCase().split(/[^\p{L}\p{N}]+/u))
			.filter((token) => token.length > 0)
	)

	return ablatedInput
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.filter((word) => word.length >= RESIDUAL_MIN_WORD_LENGTH && !/^\d+$/.test(word) && !accounted.has(word))
}

/**
 * The case's asserted components MINUS one — the input to {@linkcode deriveExpectedRung}. A rebuild rather than a
 * `delete`, so the deleted key cannot survive as an `undefined` own property that `in` would still see.
 */
export function withoutComponent(components: Readonly<Record<string, string>>, deleted: string): RemainingComponents {
	return Object.fromEntries(Object.entries(components).filter(([tag]) => tag !== deleted))
}

/**
 * An expectation, rendered for the artifact: the rung's name, its depth, the one-sentence derivation, and where it came
 * from.
 */
export interface ExpectedRungDescription {
	expected: ExpectedRung | null
	rungName: string
	depth: number | null
	why: string
	source: "derived" | "override" | "no-ladder"
}

/**
 * Build the degradation ladder for one corpus row.
 *
 * Rung 0 is the CORPUS's own asserted coordinate when the row has one, and the pipeline's undeleted answer only
 * otherwise. Rungs 1..n are the chain CONTAINING that coordinate — a reverse geocode, not the pipeline's hierarchy.
 *
 * Both choices are the same lesson from the 2026-08-05 smoke run, which built ladders out of the anchor's resolved
 * hierarchy and produced two fictions. `bd-op2-ginza` (an `improvement_target` row, i.e. wrong on purpose) anchored at
 * -34.60, 150.40 — Wollongong, Australia — under a Dhaka hierarchy, so rung 0 sat 9,063 km outside its own country rung
 * and the postcode-deleted variant that resolved Dhaka CORRECTLY graded as a failure. `bm-op3-daniels-head-beach-
 * park`, asserted in Bermuda, drew a ladder of Beach Park → Benton Township → Lake → Illinois → United States off a
 * mis-resolved anchor, and the US rung's real bbox is 6,739 km wide, so a Bermuda coordinate sat comfortably inside it
 * and no coherence check could catch it.
 *
 * Containment removes the class: a chain derived FROM the coordinate cannot disagree with the coordinate. It also
 * removes the last circularity — with an asserted coordinate, nothing in the ladder comes from the parser at all.
 *
 * `null` (with the reason) whenever the ladder would still be a fiction: no coordinate to anchor it, no containing
 * place, or no rung that survived the radius rule.
 */
export function buildCaseLadder(
	anchor: { lat: number | null; lon: number | null },
	toleranceKm: number,
	gz: AblationGazetteerProbe,
	/**
	 * The row's asserted coordinate (`expect_lat` / `expect_lon`), when it has one.
	 */
	expected?: { lat: number | null; lon: number | null },
	/**
	 * The row's STATED country (the corpus's `country` column, ISO-3166 alpha-2) — corpus metadata, never a pipeline
	 * output, and the only independent check on the containment walk available here.
	 */
	statedCountry?: string
): { ladder: AblationLadder; anchorSource: "corpus-expected" | "pipeline-anchor" } | { ladder: null; reason: string } {
	const useExpected = expected?.lat != null && expected.lon != null
	const base = useExpected ? { lat: expected!.lat!, lon: expected!.lon! } : { lat: anchor.lat, lon: anchor.lon }

	if (base.lat == null || base.lon == null) {
		return { ladder: null, reason: "no asserted coordinate and the row's own anchor never resolved" }
	}

	const chain = gz.containingChain(base.lat, base.lon)

	if (!chain.length) {
		return {
			ladder: null,
			reason: `no gazetteer place contains ${base.lat.toFixed(4)}, ${base.lon.toFixed(4)} (open water, or outside coverage)`,
		}
	}

	// The corpus's own `country` column against the country the walk arrived in. A mismatch has two very different
	// causes and the message must say which, because they ask for different work:
	//
	//  - Rung 0 came from the ASSERTED coordinate → the containment walk is at fault. It starts from `place_bbox`, and a
	//    place whose bbox is degenerate is never a candidate, so a small country is MISSED and its points are attributed
	//    to a large neighbour. The 2026-08-05 Bermuda rows reverse-geocoded to `United States`, whose real bbox spans
	//    6,739 km, and the one-rung ladder that produced endorsed answers 700 km into Tennessee.
	//  - Rung 0 came from the PIPELINE (the row asserts no coordinate) → the undeleted parse is already in the wrong
	//    country, and no deletion measured against it means anything.
	const chainCountry = chain.at(-1)!.country

	if (statedCountry && chainCountry && chainCountry !== statedCountry) {
		const where = `${base.lat.toFixed(4)}, ${base.lon.toFixed(4)}`

		return {
			ladder: null,
			reason: useExpected
				? `INCOHERENT — the containment walk puts the ASSERTED coordinate (${where}) in ${chainCountry}, the corpus says ` +
					`${statedCountry}: a degenerate-bbox place the reverse walk cannot see`
				: `INCOHERENT — this row asserts no coordinate, and its UNDELETED answer (${where}) resolves to ${chainCountry} ` +
					`while the corpus says ${statedCountry}: the base parse is already wrong, so no deletion can be measured against it`,
		}
	}

	const ladder = ablationLadderFromChain({ lat: base.lat, lon: base.lon }, chain, toleranceKm)

	if (ladder.rungs.length < 2) {
		return {
			ladder: null,
			reason: `no containment rung survived the radius rule (${chain.length} places contained it)`,
		}
	}

	return { ladder, anchorSource: useExpected ? "corpus-expected" : "pipeline-anchor" }
}

/**
 * The expectation for one deletion: the per-case pin when there is one, else the derivation from what REMAINS.
 *
 * The remaining set is the case's asserted components MINUS the deleted one. That is the whole input to the expectation
 * — the ablated arm's result is not a parameter here and must never become one (see `ablation-expectation.ts`;
 * `ablation-expectation.test.ts` pins the invariance).
 *
 * A pin that names a rung the ladder does not have falls back to the derivation and SAYS SO in `why`, rather than
 * quietly reporting a derived verdict under the pin's name.
 */
export function expectFor(input: {
	ladder: AblationLadder | null
	components: Record<string, string>
	deleted: string
	pin: string | undefined
	gz: AblationGazetteerProbe
	/**
	 * The variant's input text — read ONLY to find words no surviving component accounts for ({@linkcode residualWords}).
	 * Not the variant's output; the expectation stays non-circular.
	 */
	ablatedInput: string
}): ExpectedRungDescription {
	if (!input.ladder) {
		return {
			expected: null,
			rungName: ABLATION_ABSENT,
			depth: null,
			why: "no ladder for this row",
			source: "no-ladder",
		}
	}

	const pinned = input.pin ? overrideToExpectedRung(input.pin, input.ladder) : null

	if (input.pin && !pinned) {
		const remaining = withoutComponent(input.components, input.deleted)
		const derived = deriveExpectedRung(remaining, input.ladder, input.gz, residualWords(input.ablatedInput, remaining))

		return {
			expected: derived,
			...describeExpected(derived, input.ladder),
			why: `${describeExpected(derived, input.ladder).why} (override "${input.pin}" names no rung on this ladder — ignored)`,
			source: "derived",
		}
	}

	if (pinned) {
		return { expected: pinned, ...describeExpected(pinned, input.ladder), source: "override" }
	}

	const remaining = withoutComponent(input.components, input.deleted)
	const derived = deriveExpectedRung(remaining, input.ladder, input.gz, residualWords(input.ablatedInput, remaining))

	return { expected: derived, ...describeExpected(derived, input.ladder), source: "derived" }
}

function describeExpected(
	expected: ExpectedRung,
	ladder: AblationLadder
): { rungName: string; depth: number | null; why: string } {
	if (expected.kind === ABSTAIN_RUNG || expected.kind === UNCONSTRAINED_RUNG) {
		return { rungName: expected.kind, depth: null, why: expected.why }
	}

	return { rungName: ladder.rungs[expected.depth]?.kind ?? "base", depth: expected.depth, why: expected.why }
}

/**
 * Render a ladder for the artifact — one line per rung, plus its radius and where the radius came from.
 */
export function describeLadder(ladder: AblationLadder): string[] {
	return ladder.rungs.map((r) => `${r.depth}:${r.kind} ${r.name} ±${r.radiusKM.toFixed(2)}km (${r.radiusSource})`)
}
