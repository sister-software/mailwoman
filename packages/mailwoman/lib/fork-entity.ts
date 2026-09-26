/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Resolves declared forks and venue names against the POI database.
 */

import { isUnitGradePostcodeHit } from "@mailwoman/codex"
import { collectNodes, type AddressNode } from "@mailwoman/core/decoder"
import { normalizeLocalityForKey } from "@mailwoman/resolver-wof-sqlite/street"
import { haversineKm } from "@mailwoman/spatial"

import { type AdminCoherenceReport, type AdminCoherenceTreeNode, forkedEntityCoherenceField } from "#admin-coherence"
import { epistemicStatusFor } from "#geocode/epistemic-status"
import type { POIExecutorLookup } from "#poi/executor"

/**
 * The maximum distance in meters between two same-name rows treated as one venue.
 */
const SAME_ENTITY_M = 150

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
	 * The probe rejects queries containing one so a street name does not match a venue.
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
 * Finds the single entity worldwide whose name key equals the query's, or returns `null`.
 *
 * The probe returns `null` when the query contains a street-type token or
 * when more than one distinct entity matches.
 */
export function probeForkEntity(rawQuery: string, opts: ForkEntityProbeOpts): ForkEntityHit | null {
	const nameKey = normalizeLocalityForKey(rawQuery)

	if (!nameKey) return null

	for (const token of nameKey.split(" ")) {
		if (token && opts.isStreetGeneric(token)) return null
	}

	// FTS ranks by bm25, so the exact-name row may not be first.
	// The limit leaves room to find it.
	const hits = opts.lookup.search({ name: rawQuery, limit: 24 })

	// Only exact name-key matches count.
	// FTS also returns partial matches such as "Comer Park" for "comer".
	const exact = hits.filter((h) => h.name !== null && normalizeLocalityForKey(h.name) === nameKey)

	if (!exact.length) return null

	// One venue often has several nearby rows.
	// Merge them, keeping the most confident row.
	const entities: Array<(typeof exact)[number]> = []

	for (const hit of exact) {
		const twin = entities.find((e) => distanceM(e.latitude, e.longitude, hit.latitude, hit.longitude) <= SAME_ENTITY_M)

		if (twin) {
			if (hit.confidence > twin.confidence) {
				entities[entities.indexOf(twin)] = hit
			}

			continue
		}

		entities.push(hit)
	}

	if (entities.length !== 1) return null

	const top = entities[0]!

	return {
		name: top.name ?? rawQuery,
		categoryID: top.categoryID,
		latitude: top.latitude,
		longitude: top.longitude,
		country: top.country,
		confidence: top.confidence,
	}
}

/**
 * The outcome fields that an entity answer writes.
 *
 * The type is structural to avoid an import cycle with the outcome module.
 */
export interface ForkEntityAnswerTarget {
	lat: number | null
	lon: number | null
	resolution_tier: string | null
	epistemic_status?: string
	countryCode: string | null
	venue: string | null
	entity?: { name: string; categoryID: string | null; confidence: number; country: string }
	admin_coherence?: AdminCoherenceReport
}

/**
 * Writes the entity's coordinates, the venue tier, and the admin coherence report to the outcome.
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
	result.countryCode = entity.country
	result.venue = entity.name

	result.entity = {
		name: entity.name,
		categoryID: entity.categoryID,
		confidence: entity.confidence,
		country: entity.country,
	}

	const coherence = forkedEntityCoherenceField(roots, entity)

	if (coherence.admin_coherence) {
		result.admin_coherence = coherence.admin_coherence
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
 * Returns the venue search radius for an anchor.
 *
 * The radius is tighter when the anchor coordinate came from a unit-grade postcode node.
 */
export function venueAnchorRadiusM(anchor: { lat: number; lon: number }, roots: readonly AddressNode[]): number {
	const postcode = collectNodes(
		roots,
		(node) => node.tag === "postcode" && node.lat === anchor.lat && node.lon === anchor.lon
	)[0]

	if (!postcode) return VENUE_ANCHOR_THRESHOLD_M

	const resolverName = postcode.metadata?.["resolver_name"]

	return isUnitGradePostcodeHit(postcode.value, typeof resolverName === "string" ? resolverName : undefined)
		? VENUE_UNIT_ANCHOR_THRESHOLD_M
		: VENUE_ANCHOR_THRESHOLD_M
}

/**
 * Finds the single exact-name venue within the anchor's radius, or returns `null`.
 */
export function probeVenueNearAnchor(
	venueRaw: string,
	anchor: VenueAnchor,
	opts: Pick<ForkEntityProbeOpts, "lookup">
): ForkEntityHit | null {
	const nameKey = normalizeLocalityForKey(venueRaw)

	if (!nameKey) return null

	const hits = opts.lookup.search({ name: venueRaw, limit: 24 })
	const exact = hits.filter((h) => h.name !== null && normalizeLocalityForKey(h.name) === nameKey)

	if (!exact.length) return null

	// Merge nearby duplicate rows, as in probeForkEntity.
	const entities: Array<(typeof exact)[number]> = []

	for (const hit of exact) {
		const twin = entities.find((e) => distanceM(e.latitude, e.longitude, hit.latitude, hit.longitude) <= SAME_ENTITY_M)

		if (twin) {
			if (hit.confidence > twin.confidence) {
				entities[entities.indexOf(twin)] = hit
			}

			continue
		}

		entities.push(hit)
	}

	const radiusM = anchor.radiusM ?? VENUE_ANCHOR_THRESHOLD_M

	const near = entities.filter((e) => distanceM(anchor.lat, anchor.lon, e.latitude, e.longitude) <= radiusM)

	if (near.length !== 1) return null

	const top = near[0]!

	return {
		name: top.name ?? venueRaw,
		categoryID: top.categoryID,
		latitude: top.latitude,
		longitude: top.longitude,
		country: top.country,
		confidence: top.confidence,
	}
}

/**
 * Applies the fork-entity probe, then the optional near-anchor venue refinement.
 *
 * The fork probe runs only for a declared fork with no coordinate.
 * The venue refinement runs only when `poiVenueTier` is set and the current tier is `admin`
 * or `street`, so it never replaces an address-point or interpolation result.
 */
export function applyEntityTiers(
	result: ForkEntityAnswerTarget & {
		resolution_tier: string | null
		entity?: { name: string; categoryID: string | null; confidence: number; country: string }
	},
	markers: readonly { code: string }[],
	parseInput: string,
	resolvedRoots: readonly AddressNode[],
	deps: {
		poiLookup?: ForkEntityProbeOpts["lookup"]
		isStreetGeneric?: ForkEntityProbeOpts["isStreetGeneric"]
		poiVenueTier?: boolean
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
		deps.poiLookup &&
		result.venue &&
		result.lat !== null &&
		result.lon !== null &&
		(result.resolution_tier === "admin" || result.resolution_tier === "street")
	) {
		const anchor = { lat: result.lat, lon: result.lon }

		const hit = probeVenueNearAnchorFolded(
			result.venue,
			{ ...anchor, radiusM: venueAnchorRadiusM(anchor, resolvedRoots) },
			{ lookup: deps.poiLookup }
		)

		if (hit) {
			result.lat = hit.latitude
			result.lon = hit.longitude
			result.resolution_tier = "venue"
			result.epistemic_status = epistemicStatusFor("venue", result.lat)
			result.entity = { name: hit.name, categoryID: hit.categoryID, confidence: hit.confidence, country: hit.country }
		}
	}
}

/**
 * Returns the head of a decorated venue name.
 *
 * The head is the text before the first spaced dash, with any trailing parenthetical removed.
 * For example, "The North Face - Covent Garden" becomes "The North Face".
 *
 * It returns null when no text was removed or when the head is a single word,
 * because a one-word head matches too broadly.
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
 * Runs {@link probeVenueNearAnchor}, then retries by comparing name heads when it finds no match.
 *
 * The retry compares {@link venueHeadSegment} of the query and of each row.
 * It still requires a single match within the radius, so a chain with two nearby branches returns `null`.
 */
export function probeVenueNearAnchorFolded(
	venueRaw: string,
	anchor: VenueAnchor,
	opts: Pick<ForkEntityProbeOpts, "lookup">
): ForkEntityHit | null {
	const exact = probeVenueNearAnchor(venueRaw, anchor, opts)

	if (exact) return exact

	// Either side may carry the decoration, so the retry runs even when the query has no head to strip.
	const queryHead = venueHeadSegment(venueRaw) ?? venueRaw.trim()
	const queryKey = normalizeLocalityForKey(queryHead)

	if (!queryKey) return null

	const hits = opts.lookup.search({ name: queryHead, limit: 24 })

	const folded = hits.filter((h) => {
		if (h.name === null) return false
		const hitHead = venueHeadSegment(h.name) ?? h.name

		return normalizeLocalityForKey(hitHead) === queryKey
	})

	if (!folded.length) return null

	const entities: Array<(typeof folded)[number]> = []

	for (const hit of folded) {
		const twin = entities.find((e) => distanceM(e.latitude, e.longitude, hit.latitude, hit.longitude) <= SAME_ENTITY_M)

		if (twin) {
			if (hit.confidence > twin.confidence) {
				entities[entities.indexOf(twin)] = hit
			}

			continue
		}

		entities.push(hit)
	}

	const radiusM = anchor.radiusM ?? VENUE_ANCHOR_THRESHOLD_M

	const near = entities.filter((e) => distanceM(anchor.lat, anchor.lon, e.latitude, e.longitude) <= radiusM)

	if (near.length !== 1) return null

	const top = near[0]!

	return {
		name: top.name ?? venueRaw,
		categoryID: top.categoryID,
		latitude: top.latitude,
		longitude: top.longitude,
		country: top.country,
		confidence: top.confidence,
	}
}
