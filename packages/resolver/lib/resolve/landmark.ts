/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Answers a query that is a place's name, with no street or postcode, from the landmark layer.
 *
 *   The place of that name with the most Wikipedia language editions answers, and the others stay as alternatives. A
 *   prominence of log10(sitelinks) puts the lead on the scale the admin tier's `declared_ambiguity` margin reads, so a
 *   close call is declared by the same rule that declares one between two towns.
 */

import { walkNodes, type AddressNode } from "@mailwoman/core/decoder"
import { EMPTY_PLACE_FIELDS, type LandmarkHit, type LandmarkLookup, type ResolvedPlace } from "@mailwoman/core/resolver"
import { haversine } from "@mailwoman/spatial/geometries/point/distance"

import { decorateNode } from "#decorate-node"
import { writtenCountryCode } from "#resolve/country-code"

/**
 * The tags that make an input an address.
 * A landmark name cannot answer an address.
 */
const ADDRESS_TAGS: ReadonlySet<string> = new Set(["house_number", "postcode", "unit", "po_box"])

/**
 * The farthest a landmark may lie from a locality the input states, matching span rescore's postcode radius.
 */
const STATED_LOCALITY_RADIUS_KM = 50

/**
 * Keeps the hits an input's stated context permits: its country, and the surroundings of its locality.
 */
function hitsInContext(hits: readonly LandmarkHit[], context: readonly AddressNode[]): LandmarkHit[] {
	const country = context
		.map((node) => node.metadata?.["resolver_country"])
		.find((code): code is string => typeof code === "string")

	const locality = context.find((node) => node.tag === "locality" && node.lat != null && node.lon != null)

	return hits.filter(
		(hit) =>
			hit.country === country &&
			(!locality || haversine(locality.lat!, locality.lon!, hit.lat, hit.lon) <= STATED_LOCALITY_RADIUS_KM)
	)
}

function placeOf(hit: LandmarkHit): ResolvedPlace {
	const prominence = Math.log10(hit.sitelinks + 1)

	return {
		...EMPTY_PLACE_FIELDS,
		id: hit.qid,
		name: hit.name,
		placetype: "venue",
		country: hit.country,
		lat: hit.lat,
		lon: hit.lon,
		parent_id: null,
		score: prominence,
		prominence,
		exactMatch: true,
	}
}

/**
 * Replaces the parse's reading of a landmark name with a venue node that holds the answer.
 *
 * The first comma-separated part is the name, and any other part is context that has to have resolved.
 * A settlement that leads the name stays with the admin ladder, because the ladder ranks settlements.
 */
export function applyLandmark(roots: AddressNode[], raw: string, landmarks: LandmarkLookup): void {
	const nodes = [...walkNodes(roots)]

	if (nodes.some((node) => ADDRESS_TAGS.has(node.tag))) return

	const name = raw.split(",", 1)[0]!.trim()

	if (!name) return

	const hits = landmarks.find(name)

	if (!hits.length) return

	const nameEnd = raw.indexOf(name) + name.length
	const hasContext = raw.trim().length > name.length
	const context = roots.filter((node) => node.start >= nameEnd && typeof node.placeID === "string")

	if (hasContext && !context.length) return

	// A bare country code answers the country.
	// With context, `FRA, Germany` can still reach the airport.
	if (!hasContext && writtenCountryCode(name)) return

	const candidates = hasContext ? hitsInContext(hits, context) : hits
	const leader = candidates[0]

	if (!leader || leader.kind !== "venue") return

	// A translation or alias is the weakest claim on a name, so it answers only where the
	// gazetteer holds none: `Hamburg` is an alias of Hamburg Airport and the name of a city.
	const nameResolved = roots.some(
		(root) =>
			typeof root.placeID === "string" && (root.start < nameEnd || root.value.toLowerCase() === name.toLowerCase())
	)

	if (!leader.primary && !leader.code && nameResolved) return

	const node: AddressNode = {
		tag: "venue",
		value: name,
		start: raw.indexOf(name),
		end: nameEnd,
		confidence: 1,
		children: [],
	}

	decorateNode(node, placeOf(leader), candidates.slice(1).map(placeOf))
	node.placeID = `wikidata:${leader.qid}`
	node.metadata = { ...node.metadata, landmark_sitelinks: leader.sitelinks }

	roots.splice(0, roots.length, node, ...context)
}
