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
 *      (`gb-fork-entity-savile-row-guard` is the live tripwire).
 *   3. **Exactly one entity worldwide bears the name** (name-key EXACT equality, duplicate rows of
 *      the same physical venue collapsed by proximity). Zero is a miss; two is an ambiguity the
 *      query gave no anchor to break — both abstain. The uniqueness bar is what lets an anchorless
 *      query resolve at all.
 */

import { normalizeLocalityForKey } from "@mailwoman/resolver-wof-sqlite/street-normalize"

import {
	type AdminCoherenceReport,
	type AdminCoherenceTreeNode,
	forkedEntityCoherenceField,
} from "./admin-coherence.ts"
import type { POIExecutorLookup } from "./poi-executor.ts"

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
	 * it gate 2 cannot run, and an ungated probe is the Savile Row hijack — so the caller must not invoke the probe at
	 * all when no matcher is loaded.
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
export function applyForkEntityAnswer(
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
