/**
 * Graceful-degradation expectation model for gauntlet ablations.
 *
 * Builds a ladder from the asserted coordinate, derives expected depth from surviving
 * evidence, and grades relative to the undeleted answer.
 */

import { haversineKm } from "@mailwoman/spatial"

import type { AblationGrade } from "#eval-harness/gauntlet/ablation/grades"

/**
 * Place shape required by this model.
 */
export interface AblationPlace {
	id: number
	name: string
	placetype: string
	/**
	 * ISO-3166 alpha-2 country code.
	 */
	country: string
	lat: number
	lon: number
	/**
	 * `null` when bbox is missing/degenerate (`min == max`).
	 */
	bbox: { minLat: number; maxLat: number; minLon: number; maxLon: number } | null
	/**
	 * `-log10(population + 1)` used for ranking (lower = more populous).
	 */
	negRank: number
	population: number | null
}

/**
 * Source of a rung radius.
 */
export type RungRadiusSource = "row-tolerance" | "bbox" | "placetype-floor"

/**
 * One ladder rung.
 */
export interface AblationRung {
	/**
	 * 0 = undeleted answer. Higher = coarser.
	 */
	depth: number
	/**
	 * `base` for rung 0, otherwise WOF placetype.
	 */
	kind: string
	name: string
	/**
	 * WOF id, or `null` for rung 0.
	 */
	placeID: number | null
	lat: number
	lon: number
	radiusKM: number
	radiusSource: RungRadiusSource
}

/**
 * A missing rung and why it is missing.
 */
export interface AblationLadderGap {
	placetype: string
	name: string
	reason: string
}

/**
 * Ladder for one row: base rung then ancestry.
 */
export interface AblationLadder {
	rungs: AblationRung[]
	gaps: AblationLadderGap[]
}

/**
 * Sentinel meaning "abstain is expected".
 */
export const ABSTAIN_RUNG = "abstain"

/**
 * Expected rung outcome with reason.
 */
export type ExpectedRung =
	| { kind: "rung"; depth: number; why: string }
	| { kind: typeof ABSTAIN_RUNG; why: string; homonymTakeover?: boolean }
	| { kind: typeof UNCONSTRAINED_RUNG; why: string }

/**
 * Expected state when surviving evidence includes signals this layer cannot evaluate (e.g. venue/street).
 * Any on-ladder answer or abstention is acceptable.
 */
export const UNCONSTRAINED_RUNG = "unconstrained"

export {
	ABLATION_GRADES,
	type AblationGrade,
	emptyGrades,
	PASSING_GRADES,
} from "#eval-harness/gauntlet/ablation/grades"

/**
 * Placetype fallback rung radius in km (measured p90 bbox radius).
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
 * Missing placetypes have no floor.
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
 * Distance under which two candidates are treated as the same place.
 */
export const COINCIDENT_PLACE_KM = 10

/**
 * Decisive log10 population margin for names.
 */
export const DECISIVE_MARGIN_LOG10 = 0.5

/**
 * Bboxes below this size are treated as noise.
 */
const BBOX_NOISE_FLOOR_KM = 0.1

/**
 * Placetypes used for locality-like lookups.
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
 * WOF containment depth map.
 * Coarsest = 1, unknown = 0.
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
	// Postcode is finer than admin grains so postcode pins can match correctly.
	postalcode: 12,
}

/**
 * Lookup containment depth for a placetype.
 */
export function containmentDepth(placetype: string): number {
	return PLACETYPE_CONTAINMENT_DEPTH[placetype] ?? 0
}

/**
 * Bbox radius from centroid to farthest corner.
 * Returns `null` when bbox is absent/degenerate/noisy.
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
 * Resolve rung radius and source for one place.
 * Returns `null` if no usable radius exists.
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
 * Build ladder from anchor plus containing chain (deepest first).
 *
 * Rung radii are monotonic upward.
 * A place whose radius is absent becomes a gap.
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
 * Gazetteer operations needed by this model.
 */
export interface AblationGazetteerProbe {
	/**
	 * Place by WOF id.
	 */
	place(id: number): AblationPlace | null
	/**
	 * Containment lineage (nearest first, excludes self).
	 */
	lineage(id: number): AblationPlace[]
	/**
	 * Containing admin chain for a coordinate (deepest first).
	 */
	containingChain(lat: number, lon: number): AblationPlace[]
	/**
	 * Named candidates, ranked most-populous first.
	 */
	named(name: string, opts?: { country?: string; placetypes?: readonly string[] }): AblationPlace[]
}

/**
 * Log10 population margin between top two candidates.
 */
export function dominanceMarginLog10(places: readonly AblationPlace[]): number {
	if (!places.length) return 0

	if (places.length === 1) return Infinity

	return places[1]!.negRank - places[0]!.negRank
}

/**
 * True if top candidate is decisive.
 */
export function isDecisive(places: readonly AblationPlace[]): boolean {
	return places.length > 0 && dominanceMarginLog10(places) >= DECISIVE_MARGIN_LOG10
}

/**
 * Per-case expectation override keyed by deleted component.
 * Values are `abstain`, `base`, or a placetype name.
 */
export type AblationExpectOverride = Record<string, string>

/**
 * Resolve an override pin to an expected rung.
 * Returns `null` if the rung is missing on this ladder.
 */
export function overrideToExpectedRung(pin: string, ladder: AblationLadder): ExpectedRung | null {
	if (pin === ABSTAIN_RUNG) return { kind: ABSTAIN_RUNG, why: "per-case override" }

	const rung = ladder.rungs.find((r) => r.kind === pin)

	return rung ? { kind: "rung", depth: rung.depth, why: `per-case override → ${pin}` } : null
}

/**
 * Surviving components after one deletion.
 */
export type RemainingComponents = Readonly<Record<string, string>>

/**
 * Derive expected rung from surviving evidence only.
 */
export function deriveExpectedRung(
	remaining: RemainingComponents,
	ladder: AblationLadder,
	gz: AblationGazetteerProbe,
	/**
	 * Untyped residual words from input ({@linkcode residualWords}).
	 */
	residual: readonly string[] = []
): ExpectedRung {
	const countryName = remaining["country"]?.trim()
	const regionName = remaining["region"]?.trim()
	const postcode = remaining["postcode"]?.trim()
	const localityName = (remaining["locality"] ?? remaining["dependent_locality"])?.trim()

	// Country narrows later probes when resolvable.
	const countryPlace = countryName ? (gz.named(countryName, { placetypes: ["country"] })[0] ?? null) : null
	const countryCode = countryPlace?.country || undefined

	const regionPlace = regionName
		? (gz.named(regionName, {
				placetypes: ["region", "macroregion"],
				...(countryCode ? { country: countryCode } : {}),
			})[0] ?? null)
		: null

	// Region narrows candidates using rung radius.
	const regionRadiusKm = regionPlace ? (rungRadiusKm(regionPlace)?.radiusKM ?? null) : null

	const withinRegion = (places: readonly AblationPlace[]): AblationPlace[] =>
		regionPlace && regionRadiusKm != null
			? places.filter((p) => haversineKm(regionPlace.lat, regionPlace.lon, p.lat, p.lon) <= regionRadiusKm)
			: [...places]

	// 1) Unique postcode is the strongest surviving pin.
	const postcodePlaces = postcode
		? withinRegion(gz.named(postcode, { placetypes: ["postalcode"], ...(countryCode ? { country: countryCode } : {}) }))
		: []

	const localityPlaces = localityName
		? withinRegion(
				gz.named(localityName, { placetypes: LOCALITY_PLACETYPES, ...(countryCode ? { country: countryCode } : {}) })
			)
		: []

	// Evidence this model cannot evaluate.
	// The case keeps whatever the model answered, and abstention stays unforced.
	const unevaluable = [
		remaining["venue"]?.trim(),
		remaining["street"]?.trim(),
		regionName && !regionPlace ? `region "${regionName}" (unresolved)` : undefined,
		countryName && !countryPlace ? `country "${countryName}" (unresolved)` : undefined,
		// Untyped words still in input.
		residual.length ? `${residual.length} untyped input word(s) (${residual.slice(0, 3).join(", ")})` : undefined,
	].filter((entry) => entry != null && entry.length)

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
			// Use postcode proximity to break locality ambiguity.
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

		// With street/venue evidence still present, decline instead of forcing abstain.
		return unevaluable.length
			? declineToConstrain(takeover)
			: { kind: ABSTAIN_RUNG, why: takeover, homonymTakeover: true }
	}

	// Keep rooftop requirement only when street-level evidence survives.
	const streetEvidence =
		(!!remaining["street"]?.trim() && !!remaining["house_number"]?.trim()) || !!remaining["venue"]?.trim()

	const deepestAdmin = ladder.rungs.length > 1 ? ladder.rungs[1]! : null

	if (streetEvidence && deepestAdmin && rung.depth === deepestAdmin.depth) {
		return { kind: "rung", depth: 0, why: `${why}, and the street evidence survived — the rooftop must hold` }
	}

	return { kind: "rung", depth: rung.depth, why }
}

/**
 * Check whether the ladder matches the row's own components.
 * Returns a reason if mismatched, else `null`.
 */
export function ladderComponentDisagreement(
	components: RemainingComponents,
	ladder: AblationLadder,
	gz: AblationGazetteerProbe
): string | null {
	// Only rows naming locality/postcode can be checked.
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
 * Containment depth for `region`.
 */
const REGION_GRAIN_DEPTH = 3

/**
 * Match a pinned place to a ladder rung.
 * Returns `null` if the place is off-ladder.
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
 * Deepest rung containing a coordinate, or `null` if none.
 */
export function achievedRung(lat: number, lon: number, ladder: AblationLadder): AblationRung | null {
	for (const rung of ladder.rungs) {
		if (haversineKm(rung.lat, rung.lon, lat, lon) <= rung.radiusKM) return rung
	}

	return null
}

/**
 * Grade one variant against expected rung.
 * Slot substitutions fail regardless of geometry.
 */
export function gradeAgainstLadder(input: {
	expected: ExpectedRung
	ladder: AblationLadder
	lat: number | null
	lon: number | null
	/**
	 * Deleted component slot outcome (`substituted` is hard fail).
	 */
	slot: "absent" | "recovered" | "substituted"
	/**
	 * The rung the undeleted case reached.
	 *
	 * Grading treats it as the floor.
	 * `null` means the undeleted answer is off-ladder (`ungraded`).
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

	// Deletion cost relative to undeleted rung, floored at 0.
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
		// For unconstrained cases, abstention and any on-ladder rung are acceptable.
		if (!resolved) return { grade: "correctlyAbstained", achievedRungDepth: null, degradedRungs: null }

		if (achieved == null) return { grade: "wrong", achievedRungDepth: null, degradedRungs: null }

		return { grade: fell === 0 ? "held" : "degraded", achievedRungDepth, degradedRungs: fell }
	}

	if (!resolved) return { grade: "lost", achievedRungDepth: null, degradedRungs: null }

	// Distinguish off-ladder wrong place from on-ladder over-coarsening.
	if (achieved == null) return { grade: "wrong", achievedRungDepth: null, degradedRungs: null }

	// Do not penalize below undeleted precision floor.
	if (achieved.depth > Math.max(expected.depth, anchorRungDepth)) {
		return { grade: "coarser", achievedRungDepth, degradedRungs: fell }
	}

	return { grade: fell === 0 ? "held" : "degraded", achievedRungDepth, degradedRungs: fell }
}

/**
 * Shared marker for absent cell/support/ladder in rendered tables.
 */
export const ABLATION_ABSENT = "·"

/**
 * Minimum residual token length counted as evidence.
 */
const RESIDUAL_MIN_WORD_LENGTH = 3

/**
 * Residual input words not covered by surviving typed components.
 * Short tokens and pure digits are ignored.
 */
export function residualWords(ablatedInput: string, remaining: RemainingComponents): string[] {
	const accounted = new Set(
		Object.values(remaining)
			.flatMap((value) => value.toLowerCase().split(/[^\p{L}\p{N}]+/u))
			.filter((token) => token.length)
	)

	return ablatedInput
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.filter((word) => word.length >= RESIDUAL_MIN_WORD_LENGTH && !/^\d+$/.test(word) && !accounted.has(word))
}

/**
 * Return components without the deleted key.
 */
export function withoutComponent(components: Readonly<Record<string, string>>, deleted: string): RemainingComponents {
	return Object.fromEntries(Object.entries(components).filter(([tag]) => tag !== deleted))
}

/**
 * Render-friendly expected rung description.
 */
export interface ExpectedRungDescription {
	expected: ExpectedRung | null
	rungName: string
	depth: number | null
	why: string
	source: "derived" | "override" | "no-ladder"
}

/**
 * Build one case ladder from asserted/pipeline anchor and containment chain.
 *
 * Returns `null` with reason when no coherent ladder can be built.
 */
export function buildCaseLadder(
	anchor: { lat: number | null; lon: number | null },
	toleranceKm: number,
	gz: AblationGazetteerProbe,
	/**
	 * Row asserted coordinate (`expect_lat`/`expect_lon`) if present.
	 */
	expected?: { lat: number | null; lon: number | null },
	/**
	 * Row stated country code used to validate containment.
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

	// Validate containment country against corpus country and explain mismatch source.
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
 * Build one deletion expectation from override pin or derived evidence.
 */
export function expectFor(input: {
	ladder: AblationLadder | null
	components: Record<string, string>
	deleted: string
	pin: string | undefined
	gz: AblationGazetteerProbe
	/**
	 * Variant input text, used only for residual word extraction.
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
 * Render ladder rows for artifacts.
 */
export function describeLadder(ladder: AblationLadder): string[] {
	return ladder.rungs.map((r) => `${r.depth}:${r.kind} ${r.name} ±${r.radiusKM.toFixed(2)}km (${r.radiusSource})`)
}
