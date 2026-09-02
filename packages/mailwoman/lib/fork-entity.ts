/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The declared_fork marker's first consumer (#1585's entity half): when the decoder declares that a
 *   surface reads two ways and the incumbent resolution produced NO coordinate, ask the ENTITY layer
 *   whether it simply knows the thing — positive evidence only, per the registry doctrine (registries
 *   are soft priors that add candidates; they never veto). `COMER parís.méxico` is the worked case:
 *   structure cannot decide it, no gazetteer row bears the name, and poi.db holds the exact
 *   restaurant 6 m from truth under a worldwide-unique name key.
 *
 *   Three gates, all required, each with a receipt behind it:
 *
 *   1. **The incumbent abstained** (no coordinate). The probe never contests a resolved answer — only
 *      a null can change, which is what makes the mechanism default-on under the D-rule.
 *   2. **No token of the query is a street generic** (the street-morphology FST — libpostal's
 *      thoroughfare vocabulary). The fork population's street-flavored surfaces (`Savile Row`,
 *      `Kärntner Straße`, `Gran Vía`) belong to the street tier, and poi.db holds exactly one poi
 *      NAMED `savile row` — without this gate the famous street would resolve to a shop
 *      (`gb-fork-entity-savile-row-guard` is the live regression check).
 *   3. **Exactly one entity worldwide bears the name** (name-key EXACT equality, duplicate rows of
 *      the same physical venue collapsed by proximity). Zero is a miss; two is an ambiguity the
 *      query gave no anchor to break — both abstain. The uniqueness bar is what lets an anchorless
 *      query resolve at all.
 */

import type { AddressNode } from "@mailwoman/core/decoder"
import { normalizeLocalityForKey } from "@mailwoman/resolver-wof-sqlite/street"

import { type AdminCoherenceReport, type AdminCoherenceTreeNode, forkedEntityCoherenceField } from "#admin-coherence"
import type { POIExecutorLookup } from "#poi/executor"

/**
 * Two poi rows closer than this are the SAME physical venue (door + terrace, or a chain's duplicate ingest of one
 * location), not two entities. Overture duplicates of one venue measure meters apart; distinct same-name venues (a
 * franchise) are city-scale apart.
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
	 * The poi.db reader (`POILookup` satisfies this) — absent handled by the CALLER (no lookup, no probe).
	 */
	lookup: POIExecutorLookup
	/**
	 * `true` when a token is a thoroughfare generic (the street-morphology FST). The probe requires this signal: without
	 * it gate 2 cannot run, and an unrestricted probe is the Savile Row hijack — so the caller must not invoke the probe
	 * at all when no matcher is loaded.
	 */
	isStreetGeneric: (token: string) => boolean
}

/**
 * Great-circle meters — local copy of the haversine at the two-point scale this module needs; the shared
 * `@mailwoman/spatial` km helper would round through km for a 150 m gate.
 */
function distanceM(latA: number, lonA: number, latB: number, lonB: number): number {
	const R = 6_371_000
	const rad = (d: number): number => (d * Math.PI) / 180

	const h =
		Math.sin(rad(latB - latA) / 2) ** 2 +
		Math.cos(rad(latA)) * Math.cos(rad(latB)) * Math.sin(rad(lonB - lonA) / 2) ** 2

	return 2 * R * Math.asin(Math.sqrt(h))
}

/**
 * Probe the entity layer for a fork surface. Returns the single entity the world knows by this exact name, or `null`
 * (gate failed / no entity / ambiguous).
 */
export function probeForkEntity(rawQuery: string, opts: ForkEntityProbeOpts): ForkEntityHit | null {
	const nameKey = normalizeLocalityForKey(rawQuery)

	if (!nameKey) return null

	// Gate 2 — street-flavored surfaces belong to the street tier, never the entity probe.
	for (const token of nameKey.split(" ")) {
		if (token && opts.isStreetGeneric(token)) return null
	}

	// Over-fetch: FTS ranks by bm25, and the exact-name row is not guaranteed first.
	const hits = opts.lookup.search({ name: rawQuery, limit: 24 })

	// Gate 3a — name-key EXACT equality only. An FTS partial ("comer" matching "Comer Park") is not
	// the entity bearing this name.
	const exact = hits.filter((h) => h.name !== null && normalizeLocalityForKey(h.name) === nameKey)

	if (!exact.length) return null

	// Gate 3b — collapse duplicate rows of one physical venue, then require exactly ONE entity.
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
 * The slice of the geocode outcome a forked answer writes — structural, so this module does not import the outcome type
 * back out of `geocode-core` (which imports the probe from here).
 */
export interface ForkEntityAnswerTarget {
	lat: number | null
	lon: number | null
	resolution_tier: string | null
	countryCode: string | null
	venue: string | null
	entity?: { name: string; categoryID: string | null; confidence: number; country: string }
	admin_coherence?: AdminCoherenceReport
}

/**
 * Write a fork-to-entity answer onto the outcome: coordinate, venue tier, the entity block, and — like any other
 * resolved answer — a coherence verdict (#1724). The entity offers a country and no ancestor chain, so a stated region
 * grades `unverifiable` rather than going silently unchecked.
 */
function applyForkEntityAnswer(
	result: ForkEntityAnswerTarget,
	entity: ForkEntityHit,
	roots: readonly AdminCoherenceTreeNode[]
): void {
	result.lat = entity.latitude
	result.lon = entity.longitude
	result.resolution_tier = "venue"
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
 * How far a venue entity may sit from the resolved admin anchor and still be "this address's venue", meters. Wide on
 * purpose: the anchor is a LOCALITY centroid (a metro's centroid can sit 20+ km from its edges), and the gate exists to
 * separate the local bearer from same-named entities in other cities, not to assert rooftop precision.
 */
const VENUE_ANCHOR_GATE_M = 30_000

/**
 * Probe the entity layer for a parsed VENUE near a resolved anchor — the #1684 POI-half's first mechanism, and the
 * anchored sibling of {@link probeForkEntity}. The fork probe requires WORLDWIDE uniqueness because a bare fork surface
 * has no other evidence; a venue-led address DOES — the walk already resolved its admin anchor — so the discipline here
 * is LOCAL uniqueness: exact name-key entities only, and exactly ONE of them within {@link VENUE_ANCHOR_GATE_M} of the
 * anchor. Two same-named venues in one metro is a genuine ambiguity and abstains; entities beyond the gate are other
 * cities' bearers and never contest.
 */
export function probeVenueNearAnchor(
	venueRaw: string,
	anchor: { lat: number; lon: number },
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

	const near = entities.filter((e) => distanceM(anchor.lat, anchor.lon, e.latitude, e.longitude) <= VENUE_ANCHOR_GATE_M)

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
 * The entity answers, applied in tier order — extracted from `geocodeAddressOnce` as one cohesive unit (the
 * ceiling-extraction discipline):
 *
 * 1. The fork→entity probe (#1585's entity half): a DECLARED fork whose incumbent resolution produced no coordinate takes
 *    the worldwide-unique entity. Default-on under the D-rule — a null is the only thing that can change.
 * 2. The VENUE TIER (#1684's POI half) — OPT-IN, default OFF: a venue-led address that resolved only to its admin anchor
 *    upgrades to the entity bearing the venue's exact name-key near that anchor ({@link probeVenueNearAnchor} owns the
 *    local-uniqueness discipline). Measured ceiling before any mechanism existed: 30 of 55 gb_venue* board rows name a
 *    poi.db-visible venue, 15 of them tracked failures; measured effect at first light: 7 of 57 rows upgrade
 *    admin→venue, all within 0.14 km of their anchors. Never fires over an address_point/interpolated answer — a
 *    street+number that resolved rooftop IS the venue's address — and the flag stays opt-in until a full-board battery
 *    earns the D-rule promotion.
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
		const hit = probeVenueNearAnchorFolded(
			result.venue,
			{ lat: result.lat, lon: result.lon },
			{ lookup: deps.poiLookup }
		)

		if (hit) {
			result.lat = hit.latitude
			result.lon = hit.longitude
			result.resolution_tier = "venue"
			result.entity = { name: hit.name, categoryID: hit.categoryID, confidence: hit.confidence, country: hit.country }
		}
	}
}

/**
 * The head segment of a QUALIFIER-DECORATED venue name: everything before the first dash-style separator, with any
 * trailing parenthetical dropped. Board-measured classes (2026-08-19): the input carries the marketing string while the
 * poi row carries the bare name or a differently-combined one — "Mischicks Day Spa - St Andrews Lakes - Rochester,
 * Kent" vs the row "Mischicks Day Spa - St Andrews Lakes"; "The North Face - Covent Garden" vs the row "The North
 * Face". Returns null when stripping changes nothing (no second leg to run) or when the head collapses to a single
 * token (a one-word head like "The" matches everything and means nothing).
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
 * {@link probeVenueNearAnchor} with the qualifier-folding second leg: the exact leg runs first and an exact local-unique
 * hit is never second-guessed; only when it abstains does the probe retry comparing HEAD SEGMENTS on both sides ({@link
 * venueHeadSegment}). Local uniqueness binds on the folded key exactly as on the exact one — a chain with two branches
 * in the metro ("The North Face" twice in London) abstains.
 */
export function probeVenueNearAnchorFolded(
	venueRaw: string,
	anchor: { lat: number; lon: number },
	opts: Pick<ForkEntityProbeOpts, "lookup">
): ForkEntityHit | null {
	const exact = probeVenueNearAnchor(venueRaw, anchor, opts)

	if (exact) return exact

	// The fold can land on EITHER side: the query's head against a bare row, or the query against a
	// decorated row's head — so the comparison folds both, and the leg runs even when only the hit
	// side can differ.
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

	const near = entities.filter((e) => distanceM(anchor.lat, anchor.lon, e.latitude, e.longitude) <= VENUE_ANCHOR_GATE_M)

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
