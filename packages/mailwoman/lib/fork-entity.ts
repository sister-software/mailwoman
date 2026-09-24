/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Resolve declared forks only when incumbent resolution has no coordinate.
 *   Require no street-generic token and one exact-name entity worldwide.
 *   Venue-led addresses use a separate, opt-in near-anchor lookup.
 */

import { isUnitGradePostcodeHit } from "@mailwoman/codex"
import { collectNodes, type AddressNode } from "@mailwoman/core/decoder"
import { normalizeLocalityForKey } from "@mailwoman/resolver-wof-sqlite/street"
import { haversineKm } from "@mailwoman/spatial"

import { type AdminCoherenceReport, type AdminCoherenceTreeNode, forkedEntityCoherenceField } from "#admin-coherence"
import { epistemicStatusFor } from "#geocode/epistemic-status"
import type { POIExecutorLookup } from "#poi/executor"

/**
 * Maximum separation for collapsing duplicate rows of one physical venue.
 */
const SAME_ENTITY_M = 150

export interface ForkEntityHit {
	name: string
	categoryID: string | null
	latitude: number
	longitude: number
	country: string
	confidence: number
}

export interface ForkEntityProbeOpts {
	/**
	 * poi.db reader; the caller skips probing when absent.
	 */
	lookup: POIExecutorLookup
	/**
	 * Detect street-type tokens; required to prevent street-to-venue matches.
	 */
	isStreetGeneric: (token: string) => boolean
}

/**
 * Return great-circle distance in meters.
 */
function distanceM(latA: number, lonA: number, latB: number, lonB: number): number {
	return haversineKm(latA, lonA, latB, lonB) * 1000
}

/**
 * Find the unique exact-name entity for a fork surface, or return `null`.
 */
export function probeForkEntity(rawQuery: string, opts: ForkEntityProbeOpts): ForkEntityHit | null {
	const nameKey = normalizeLocalityForKey(rawQuery)

	if (!nameKey) return null

	// Condition 2 — street-flavored surfaces belong to the street tier, never the entity probe.
	for (const token of nameKey.split(" ")) {
		if (token && opts.isStreetGeneric(token)) return null
	}

	// Over-fetch: FTS ranks by bm25, and the exact-name row is not guaranteed first.
	const hits = opts.lookup.search({ name: rawQuery, limit: 24 })

	// Condition 3a — name-key exact equality only.
	// An FTS partial ("comer" matching "Comer Park") is not the entity with this name.
	const exact = hits.filter((h) => h.name !== null && normalizeLocalityForKey(h.name) === nameKey)

	if (!exact.length) return null

	// Condition 3b — collapse duplicate rows of one physical venue, then require exactly one entity.
	const entities: Array<(typeof exact)[number]> = []

	for (const hit of exact) {
		const twin = entities.find((e) => distanceM(e.latitude, e.longitude, hit.latitude, hit.longitude) <= SAME_ENTITY_M)

		if (twin) {
			// Keep the more confident row of the pair.
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
 * Outcome fields written by a fork answer, defined structurally to avoid an import cycle.
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
 * Add entity coordinates, venue tier, and coherence to the outcome.
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
 * Maximum venue distance from an admin-centroid anchor, in meters.
 */
const VENUE_ANCHOR_THRESHOLD_M = 30_000

/**
 * Maximum venue distance from a unit-grade postcode anchor, in meters.
 */
const VENUE_UNIT_ANCHOR_THRESHOLD_M = 1000

/**
 * Venue lookup anchor and optional search radius.
 */
export interface VenueAnchor {
	lat: number
	lon: number
	radiusM?: number
}

/**
 * Select the venue radius based on the postcode node matching the current answer coordinate.
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
 * Find the unique exact-name venue within the resolved anchor's radius.
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

	// Same duplicate-row collapse as the fork probe: one physical venue often carries several rows.
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
 * Apply fork rescue first, then optional near-anchor venue refinement.
 *
 * Venue refinement does not replace address-point or interpolation results.
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
 * The head segment of a qualifier-decorated venue name: everything before the first
 * dash-style separator, with any trailing parenthetical dropped.
 *
 * Board-measured classes (2026-08-19): the input carries the marketing string while the
 * poi row carries the bare name or a differently-combined one — "Mischicks Day Spa -
 * St Andrews Lakes - Rochester, Kent" vs the row "Mischicks Day Spa - St Andrews Lakes";
 * "The North Face - Covent Garden" vs the row "The North Face".
 * Returns null when stripping changes nothing (no second leg to run) or when the head collapses
 * to a single token (a one-word head like "The" matches everything and means nothing).
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
 * {@link probeVenueNearAnchor} with the qualifier-folding second leg: the exact leg
 * runs first and an exact local-unique hit is never second-guessed.
 *
 * Only when it abstains does the probe retry comparing head segments on both
 * sides ({@link venueHeadSegment}).
 * Local uniqueness binds on the folded key exactly as on the exact one — a chain with
 * two branches in the metro ("The North Face" twice in London) abstains.
 */
export function probeVenueNearAnchorFolded(
	venueRaw: string,
	anchor: VenueAnchor,
	opts: Pick<ForkEntityProbeOpts, "lookup">
): ForkEntityHit | null {
	const exact = probeVenueNearAnchor(venueRaw, anchor, opts)

	if (exact) return exact

	// The fold can land on either side: the query's head against a bare row,
	// or the query against a decorated row's head.
	// So the comparison folds both, and the leg runs even when only the hit side can differ.
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
