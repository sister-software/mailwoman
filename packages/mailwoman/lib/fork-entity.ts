/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Resolves declared forks and venue names against the POI database.
 */

import { collectNodes, type AddressNode } from "@mailwoman/core/decoder"
import type { AdminCoherenceReport } from "@mailwoman/core/geocode"
import { isUnitGradePostcodeHit } from "@mailwoman/postcode/systems"
import { normalizeLocalityForKey } from "@mailwoman/resolver-wof-sqlite/street"
import { haversineKm } from "@mailwoman/spatial"

import { type AdminCoherenceTreeNode, forkedEntityCoherenceField } from "#admin-coherence"
import { epistemicStatusFor } from "#geocode/epistemic-status"
import type { POIExecutorLookup } from "#poi/executor"

/**
 * The maximum distance in meters between two same-name rows treated as one venue.
 */
const SAME_ENTITY_M = 150

/**
 * The distance in meters within which a row whose name contains the query's name corroborates an exact row.
 *
 * The rows that decorate a landmark's name, such as `Empire State Building - 102nd Floor`
 * or `Hampton Inn Manhattan-35th Street and Empire State Building`, sit beside the landmark
 * and not beside a second exact row elsewhere in the city.
 */
const CORROBORATION_M = 1000

type POIHit = ReturnType<POIExecutorLookup["search"]>[number]

/**
 * The exact-name rows a search returns, beside the rows that decorate the name.
 */
interface ExactEntities {
	/**
	 * Exact-name rows, with the rows of one physical venue merged into its most confident row.
	 */
	entities: POIHit[]
	/**
	 * Rows whose name contains the query's name key without equaling it.
	 */
	decorated: POIHit[]
}

/**
 * Searches the POI database for the query and splits the hits into exact rows and decorated rows.
 *
 * FTS ranks by bm25, so the exact-name row may not be first and the limit leaves room to find it.
 * Returns `null` for a query that normalizes to an empty key.
 */
function exactEntities(venueRaw: string, opts: Pick<ForkEntityProbeOpts, "lookup">): ExactEntities | null {
	const nameKey = normalizeLocalityForKey(venueRaw)

	if (!nameKey) return null

	const exact: POIHit[] = []
	const decorated: POIHit[] = []

	for (const hit of opts.lookup.search({ name: venueRaw, limit: 24 })) {
		if (hit.name === null) continue
		const key = normalizeLocalityForKey(hit.name)

		if (key === nameKey) {
			exact.push(hit)
		} else if (key.includes(nameKey)) {
			decorated.push(hit)
		}
	}

	return { entities: mergeSameEntityRows(exact), decorated }
}

/**
 * Merges rows of one physical venue, a short distance apart, into the most confident row.
 */
function mergeSameEntityRows(rows: readonly POIHit[]): POIHit[] {
	const entities: POIHit[] = []

	for (const hit of rows) {
		const twin = entities.find((e) => distanceM(e.latitude, e.longitude, hit.latitude, hit.longitude) <= SAME_ENTITY_M)

		if (twin) {
			if (hit.confidence > twin.confidence) {
				entities[entities.indexOf(twin)] = hit
			}

			continue
		}

		entities.push(hit)
	}

	return entities
}

/**
 * Picks one of several exact rows by the decorated rows beside it, or returns `null`.
 *
 * Two rows under one name are a data ambiguity that neither confidence nor an anchor breaks:
 * the second `Empire State Building` row holds the higher confidence and both sit in New York.
 * The row with the most decorated rows within {@link CORROBORATION_M} wins
 * when it holds the maximum by itself.
 * A tie, or no decorated row near any exact row, abstains.
 */
function pickCorroborated(entities: readonly POIHit[], decorated: readonly POIHit[]): POIHit | null {
	if (entities.length === 1) return entities[0]!

	if (!entities.length || !decorated.length) return null

	const counts = entities.map(
		(entity) =>
			decorated.filter(
				(row) => distanceM(entity.latitude, entity.longitude, row.latitude, row.longitude) <= CORROBORATION_M
			).length
	)

	const most = Math.max(...counts)

	if (most === 0) return null

	const winners = entities.filter((_, index) => counts[index] === most)

	return winners.length === 1 ? winners[0]! : null
}

/**
 * Returns the probe answer for a row.
 */
function hitOf(row: POIHit, venueRaw: string): ForkEntityHit {
	return {
		name: row.name ?? venueRaw,
		categoryID: row.categoryID,
		latitude: row.latitude,
		longitude: row.longitude,
		country: row.country,
		confidence: row.confidence,
	}
}

/**
 * A POI entity matched by a probe.
 */
export interface ForkEntityHit {
	name: string
	categoryID: string | null
	latitude: number
	longitude: number
	country: string
	confidence: number
}

/**
 * Dependencies for {@link probeForkEntity}.
 */
export interface ForkEntityProbeOpts {
	/**
	 * The `poi.db` reader.
	 */
	lookup: POIExecutorLookup
	/**
	 * Returns true for a street-type token.
	 *
	 * The probe rejects a query containing one so a street name cannot match a venue.
	 */
	isStreetGeneric: (token: string) => boolean
}

/**
 * Returns the great-circle distance in meters.
 */
function distanceM(latA: number, lonA: number, latB: number, lonB: number): number {
	return haversineKm(latA, lonA, latB, lonB) * 1000
}

/**
 * Finds the entity worldwide whose name key equals the query's, or returns `null`.
 *
 * A street-type token in the query returns `null`.
 * Several entities under the name return `null` unless the decorated rows beside one
 * of them single it out, as {@link pickCorroborated} reads them.
 */
export function probeForkEntity(rawQuery: string, opts: ForkEntityProbeOpts): ForkEntityHit | null {
	const nameKey = normalizeLocalityForKey(rawQuery)

	if (!nameKey) return null

	for (const token of nameKey.split(" ")) {
		if (token && opts.isStreetGeneric(token)) return null
	}

	return probeLandmarkEntity(rawQuery, opts)
}

/**
 * Finds the entity worldwide whose name key equals a landmark name, or returns `null`.
 *
 * This is {@link probeForkEntity} without the street-type guard.
 * A landmark name holds a street-type word as its own, as `Building` in `Empire State Building`
 * and `Center` in `Rockefeller Center`, and the kind classifier has already refused a
 * name that ends in a street suffix before an input reaches the `landmark` kind.
 */
export function probeLandmarkEntity(rawQuery: string, opts: Pick<ForkEntityProbeOpts, "lookup">): ForkEntityHit | null {
	const found = exactEntities(rawQuery, opts)

	if (!found) return null

	const top = pickCorroborated(found.entities, found.decorated)

	return top ? hitOf(top, rawQuery) : null
}

/**
 * The result fields that an entity answer writes.
 *
 * The type is structural to avoid an import cycle with the result module.
 */
export interface ForkEntityAnswerTarget {
	lat: number | null
	lon: number | null
	resolution_tier: string | null
	epistemic_status?: string
	/**
	 * The register row behind the coordinate, cleared when an entity's coordinate replaces it.
	 */
	coordinate_source?: unknown
	countryCode: string | null
	venue: string | null
	entity: { name: string; categoryID: string | null; confidence: number; country: string } | null
	admin_coherence: AdminCoherenceReport | null
	/**
	 * The flat component map, cleared when the whole input names one entity.
	 */
	components?: Record<string, string | undefined>
	locality?: string | null
	region?: string | null
	postcode?: string | null
	house_number?: string | null
	street?: string | null
	dependent_locality?: string | null
	unit?: string | null
	hierarchy?: unknown[]
}

/**
 * Rewrites a result whose whole input is one entity's name as that entity and no other component.
 *
 * The parse read the name as admin words, so every component it produced and the hierarchy
 * the resolver built from them describe a place the input does not state.
 */
function answerAsWholeInputEntity(result: ForkEntityAnswerTarget, entity: ForkEntityHit): void {
	applyForkEntityAnswer(result, entity, [])

	for (const key of [
		"locality",
		"region",
		"postcode",
		"house_number",
		"street",
		"dependent_locality",
		"unit",
	] as const) {
		if (key in result) {
			result[key] = null
		}
	}

	if (result.components) {
		result.components = { venue: entity.name }
	}

	if (result.hierarchy) {
		result.hierarchy = []
	}
}

/**
 * Reports whether a resolved node's value is the whole input, so the admin race consumed it.
 */
function adminConsumedInput(roots: readonly AddressNode[], parseInput: string): boolean {
	const inputKey = normalizeLocalityForKey(parseInput)

	return collectNodes(roots, (node) => node.lat != null && normalizeLocalityForKey(node.value) === inputKey).length > 0
}

/**
 * Writes the entity's coordinates, venue tier and admin coherence report to the result.
 */
function applyForkEntityAnswer(
	result: ForkEntityAnswerTarget,
	entity: ForkEntityHit,
	roots: readonly AdminCoherenceTreeNode[]
): void {
	result.lat = entity.latitude
	result.lon = entity.longitude
	result.resolution_tier = "venue"
	result.epistemic_status = epistemicStatusFor("venue", result.lat)
	result.coordinate_source = null
	result.countryCode = entity.country
	result.venue = entity.name

	result.entity = {
		name: entity.name,
		categoryID: entity.categoryID,
		confidence: entity.confidence,
		country: entity.country,
	}

	const coherence = forkedEntityCoherenceField(roots, entity)

	if (coherence) {
		result.admin_coherence = coherence
	}
}

/**
 * The maximum venue distance in meters from an anchor that is not a unit-grade postcode.
 */
const VENUE_ANCHOR_THRESHOLD_M = 30_000

/**
 * The maximum venue distance in meters from a unit-grade postcode anchor.
 */
const VENUE_UNIT_ANCHOR_THRESHOLD_M = 1000

/**
 * The anchor coordinate for a venue lookup, with an optional radius in meters.
 */
export interface VenueAnchor {
	lat: number
	lon: number
	radiusM?: number
}

/**
 * Returns the venue search radius for an anchor, tighter when the anchor coordinate
 * came from a unit-grade postcode node.
 */
export function venueAnchorRadiusM(anchor: { lat: number; lon: number }, roots: readonly AddressNode[]): number {
	const postcode = collectNodes(
		roots,
		(node) => node.tag === "postcode" && node.lat === anchor.lat && node.lon === anchor.lon
	)[0]

	if (!postcode) return VENUE_ANCHOR_THRESHOLD_M

	const resolverName = postcode.metadata?.["resolver_name"]

	return isUnitGradePostcodeHit(postcode.value, typeof resolverName === "string" ? resolverName : null)
		? VENUE_UNIT_ANCHOR_THRESHOLD_M
		: VENUE_ANCHOR_THRESHOLD_M
}

/**
 * The exact-name probe near an anchor, with the count of exact rows inside the radius.
 *
 * The count lets a caller tell an abstention among exact rows from an absence of them.
 */
function probeExactNearAnchor(
	venueRaw: string,
	anchor: VenueAnchor,
	opts: Pick<ForkEntityProbeOpts, "lookup">
): { hit: ForkEntityHit | null; exactNear: number } {
	const found = exactEntities(venueRaw, opts)

	if (!found) return { hit: null, exactNear: 0 }

	const radiusM = anchor.radiusM ?? VENUE_ANCHOR_THRESHOLD_M

	const near = found.entities.filter((e) => distanceM(anchor.lat, anchor.lon, e.latitude, e.longitude) <= radiusM)

	const top = pickCorroborated(near, found.decorated)

	return { hit: top ? hitOf(top, venueRaw) : null, exactNear: near.length }
}

/**
 * Finds the exact-name venue within the anchor's radius, or returns `null`.
 *
 * Several exact rows inside the radius answer only when the decorated rows beside one
 * of them single it out, as {@link pickCorroborated} reads them.
 */
export function probeVenueNearAnchor(
	venueRaw: string,
	anchor: VenueAnchor,
	opts: Pick<ForkEntityProbeOpts, "lookup">
): ForkEntityHit | null {
	return probeExactNearAnchor(venueRaw, anchor, opts).hit
}

/**
 * Applies the fork-entity probe, then the optional near-anchor venue refinement.
 *
 * The fork probe runs only for a declared fork with no coordinate.
 * When `poiVenueTier` is set, a parsed venue with no coordinate takes the same exact-name probe,
 * so `Buckingham Palace` parsed as one venue span resolves without a locality to anchor it.
 *
 * The probe answers only when one entity holds the name.
 * The refinement runs only when `poiVenueTier` is set and the current tier is `admin` or `street`.
 *
 * A bare input whose kind verdict is `landmark`, with no venue span and no resolved node that covers
 * the whole input, takes the exact-name probe on the whole input, so `Empire State Building`
 * answers from the POI layer rather than from the locality Empire its first word matched.
 */
export function applyEntityTiers(
	result: ForkEntityAnswerTarget & {
		resolution_tier: string | null
		entity: { name: string; categoryID: string | null; confidence: number; country: string } | null
	},
	markers: readonly { code: string }[],
	parseInput: string,
	resolvedRoots: readonly AddressNode[],
	deps: {
		poiLookup?: ForkEntityProbeOpts["lookup"]
		isStreetGeneric?: ForkEntityProbeOpts["isStreetGeneric"]
		poiVenueTier?: boolean
		/**
		 * The kind verdict for the input, read for the bare-landmark probe.
		 */
		kind?: string
	}
): void {
	if (
		result.lat === null &&
		markers.some((m) => m.code === "declared_fork") &&
		deps.poiLookup &&
		deps.isStreetGeneric
	) {
		const entity = probeForkEntity(parseInput, { lookup: deps.poiLookup, isStreetGeneric: deps.isStreetGeneric })

		if (entity) {
			applyForkEntityAnswer(result, entity, resolvedRoots)
		}
	}

	if (
		deps.poiVenueTier === true &&
		deps.kind === "landmark" &&
		!result.venue &&
		deps.poiLookup &&
		!adminConsumedInput(resolvedRoots, parseInput)
	) {
		const entity = probeLandmarkEntity(parseInput, { lookup: deps.poiLookup })

		if (entity) {
			answerAsWholeInputEntity(result, entity)
		}
	}

	if (deps.poiVenueTier === true && result.lat === null && result.venue && deps.poiLookup && deps.isStreetGeneric) {
		const entity = probeForkEntity(result.venue, { lookup: deps.poiLookup, isStreetGeneric: deps.isStreetGeneric })

		if (entity) {
			applyForkEntityAnswer(result, entity, resolvedRoots)
		}
	}

	// An input that still has no coordinate and no venue span takes the exact-name probe on the whole input.
	// The kind classifier's landmark rules read Latin head nouns, so a station written `渋谷駅` parses
	// as an unresolved locality and would otherwise never reach the POI layer that holds it.
	// A bare street (`Rodeo Drive`) also has no coordinate, so the probe refuses an input
	// holding a street-type word and a parse holding a street, as the fork probe does.
	if (
		deps.poiVenueTier === true &&
		result.lat === null &&
		!result.venue &&
		!result.street &&
		deps.poiLookup &&
		deps.isStreetGeneric
	) {
		const entity = probeForkEntity(parseInput, { lookup: deps.poiLookup, isStreetGeneric: deps.isStreetGeneric })

		// The entity supplies the coordinate.
		// The parse keeps its components, because a bare `Southbank` is both a locality name
		// and a POI name, and the reading the parse chose stays visible to the caller.
		if (entity) {
			applyForkEntityAnswer(result, entity, resolvedRoots)
		}
	}

	if (
		deps.poiVenueTier === true &&
		deps.poiLookup &&
		result.venue &&
		result.lat !== null &&
		result.lon !== null &&
		(result.resolution_tier === "admin" || result.resolution_tier === "postcode" || result.resolution_tier === "street")
	) {
		const anchor = { lat: result.lat, lon: result.lon }

		const hit = probeVenueNearAnchorFolded(
			result.venue,
			{ ...anchor, radiusM: venueAnchorRadiusM(anchor, resolvedRoots) },
			{ lookup: deps.poiLookup, ...(deps.isStreetGeneric ? { isStreetGeneric: deps.isStreetGeneric } : {}) }
		)

		if (hit) {
			result.lat = hit.latitude
			result.lon = hit.longitude
			result.resolution_tier = "venue"
			result.epistemic_status = epistemicStatusFor("venue", result.lat)
			result.coordinate_source = null
			result.entity = { name: hit.name, categoryID: hit.categoryID, confidence: hit.confidence, country: hit.country }
		}
	}
}

/**
 * Returns the head of a decorated venue name — the text before the first spaced dash,
 * with any trailing parenthetical removed — or `null` when no text was removed.
 * A single-word head matches too broadly.
 */
function venueHeadSegment(venueRaw: string): string | null {
	let separator = -1

	for (let index = 1; index < venueRaw.length - 1; index++) {
		const character = venueRaw[index]

		if (
			(character === "-" || character === "–" || character === "—") &&
			/\s/u.test(venueRaw[index - 1]!) &&
			/\s/u.test(venueRaw[index + 1]!)
		) {
			separator = index

			break
		}
	}

	let head = (separator === -1 ? venueRaw : venueRaw.slice(0, separator)).trim()

	if (head.endsWith(")")) {
		const parenthetical = head.lastIndexOf("(")

		if (parenthetical !== -1) {
			head = head.slice(0, parenthetical).trimEnd()
		}
	}

	if (!head || head === venueRaw.trim()) return null

	if (head.split(/\s+/).length < 2) return null

	return head
}

/**
 * Runs {@link probeVenueNearAnchor}, then retries by comparing {@link venueHeadSegment}
 * of the query and of each row.
 * It still requires a single match within the radius.
 *
 * An exact row inside the radius outranks every partial-name reading: when exact rows
 * are present and the exact probe abstains among them, the retries do not run, so
 * `Empire State Building, New York, NY` cannot fall through to a row with the name `State Building`.
 */
export function probeVenueNearAnchorFolded(
	venueRaw: string,
	anchor: VenueAnchor,
	opts: Pick<ForkEntityProbeOpts, "lookup"> & Partial<Pick<ForkEntityProbeOpts, "isStreetGeneric">>
): ForkEntityHit | null {
	const exact = probeExactNearAnchor(venueRaw, anchor, opts)

	if (exact.hit) return exact.hit

	if (exact.exactNear > 0) return null

	return probeVenueHeadNearAnchor(venueRaw, anchor, opts) ?? probeVenueWithoutLeadingWord(venueRaw, anchor, opts)
}

/**
 * The fewest words the leading-word retry may probe with.
 *
 * A one-word remainder such as `Ivy` from `The Ivy` is treated as a common noun
 * rather than one venue's name.
 */
const LEADING_WORD_RETRY_MIN_REMAINDER = 2

/**
 * Retries a venue of three or more words without its first word, as in
 * `The Manchester Art Gallery`, whose POI row is `Manchester Art Gallery`.
 *
 * The retry reads no article list, so it applies to a leading determiner in any
 * script that separates words with spaces.
 * A name in a script without spaces is one word and never retried.
 *
 * The remainder must still name a single venue within the anchor's radius.
 *
 * A remainder ending in a street-type word is refused.
 * Without its brand, `UTEA Old Street` leaves the street name `Old Street`.
 * A venue row of that name would then answer the query.
 *
 * A street-type word inside the name, as `Center` in `Aquatic Visitors Center (AVC)`, does not refuse it.
 */
function probeVenueWithoutLeadingWord(
	venueRaw: string,
	anchor: VenueAnchor,
	opts: Pick<ForkEntityProbeOpts, "lookup"> & Partial<Pick<ForkEntityProbeOpts, "isStreetGeneric">>
): ForkEntityHit | null {
	const words = venueRaw.trim().split(/\s+/u)

	if (words.length - 1 < LEADING_WORD_RETRY_MIN_REMAINDER) return null

	const remainder = words.slice(1).join(" ")

	const lastWord = normalizeLocalityForKey(remainder).split(" ").at(-1)

	if (opts.isStreetGeneric && lastWord && opts.isStreetGeneric(lastWord)) return null

	return probeVenueNearAnchor(remainder, anchor, opts)
}

/**
 * Compares {@link venueHeadSegment} of the query and of each row, and requires
 * a single match within the radius.
 */
function probeVenueHeadNearAnchor(
	venueRaw: string,
	anchor: VenueAnchor,
	opts: Pick<ForkEntityProbeOpts, "lookup">
): ForkEntityHit | null {
	// Either side may include the decoration, so the retry runs even when the query has no head to strip.
	const queryHead = venueHeadSegment(venueRaw) ?? venueRaw.trim()
	const queryKey = normalizeLocalityForKey(queryHead)

	if (!queryKey) return null

	const hits = opts.lookup.search({ name: queryHead, limit: 24 })

	const folded = hits.filter((h) => {
		if (!h.name) return false
		const hitHead = venueHeadSegment(h.name) ?? h.name

		return normalizeLocalityForKey(hitHead) === queryKey
	})

	if (!folded.length) return null

	const radiusM = anchor.radiusM ?? VENUE_ANCHOR_THRESHOLD_M

	const near = mergeSameEntityRows(folded).filter(
		(e) => distanceM(anchor.lat, anchor.lon, e.latitude, e.longitude) <= radiusM
	)

	return near.length === 1 ? hitOf(near[0]!, venueRaw) : null
}
