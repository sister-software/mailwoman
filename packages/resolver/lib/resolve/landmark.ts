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
 *
 *   A code written in capitals reads by one rule. A code a country is written as answers the country, and the airport
 *   holding the same IATA code is listed as an alternative: `AUS` is Australia, then Austin–Bergstrom. Every other code
 *   answers the place holding it: `SFO`, `LHR` and `DTW` are airports. `writtenCountryCode` states which codes a country
 *   claims.
 */

import { walkNodes, type AddressNode } from "@mailwoman/core/decoder"
import {
	EMPTY_PLACE_FIELDS,
	landmarkPlaceID,
	OSM_LANDMARK_PREFIX,
	type LandmarkHit,
	type LandmarkLookup,
	type ResolvedPlace,
} from "@mailwoman/core/resolver"
import { isCountryAirportCollision } from "@mailwoman/registry/overlap/country-airport"
import { isLatLonBounds, latLonBoundsContain } from "@mailwoman/spatial/bbox"
import { haversine } from "@mailwoman/spatial/geometries/point/distance"

import { decorateNode } from "#decorate-node"
import { foldName } from "#fold-name"
import { writtenCountryCode } from "#resolve/country-code"

/**
 * The tags that make an input an address.
 * A landmark name cannot answer an address.
 */
const ADDRESS_TAGS: ReadonlySet<string> = new Set(["house_number", "postcode", "unit", "po_box"])

/**
 * The namesakes a landmark answer lists: OpenStreetMap can hold hundreds of parks under one name.
 */
const LISTED_ALTERNATIVES = 8

/**
 * The farthest a landmark may lie from a locality the input states, matching span rescore's postcode radius.
 */
const STATED_LOCALITY_RADIUS_KM = 50

/**
 * Keeps the hits an input's stated context permits: its country, and the surroundings of its locality.
 */
function hitsInContext(hits: readonly LandmarkHit[], context: readonly AddressNode[]): LandmarkHit[] {
	const nodes = [...walkNodes(context)]

	const country = nodes
		.map((node) => node.metadata?.["resolver_country"])
		.find((code): code is string => typeof code === "string")

	const locality = nodes.find((node) => node.tag === "locality" && node.lat != null && node.lon != null)
	const extent = locality?.metadata?.["resolver_bbox"]

	const distance = (hit: LandmarkHit) => (locality ? haversine(locality.lat!, locality.lon!, hit.lat, hit.lon) : 0)

	// OpenStreetMap holds a St Mary's in every village, so a stated town's own extent
	// bounds its places where the gazetteer holds one.
	// Wikipedia editions separate famous namesakes, so a Wikidata place keeps the wider radius.
	const inLocality = (hit: LandmarkHit) =>
		hit.qid.startsWith(OSM_LANDMARK_PREFIX) && isLatLonBounds(extent)
			? latLonBoundsContain(extent, hit.lat, hit.lon)
			: distance(hit) <= STATED_LOCALITY_RADIUS_KM

	const kept = hits.filter((hit) => hit.country === country && inLocality(hit))

	return kept.every((hit) => hit.qid.startsWith(OSM_LANDMARK_PREFIX))
		? kept.toSorted((a, b) => distance(a) - distance(b))
		: kept
}

function placeOf(hit: LandmarkHit): ResolvedPlace {
	const prominence = hit.importance ?? Math.log10(hit.sitelinks + 1)

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
 * Lists every landmark that holds the written code on the resolved country node, as its alternatives.
 *
 * `AUS` answers Australia, and Austin–Bergstrom International Airport is the
 * reading a caller can pick instead.
 * A word spelled like the code, such as the town of Usa under `USA`,
 * is not a holder of the code and stays out.
 *
 * The list sits on a resolved country node, so a country the gazetteer left unresolved keeps its parse.
 *
 * The node also records `code_collision`, the identifier registry's verdict on whether the written
 * code is both an officially assigned ISO 3166-1 alpha-3 code and an IATA airport code in its profile.
 * The registry and the landmark layer read different sources, so the flag
 * and the listed holders can disagree, and both are kept.
 */
function listCodeHoldersOnCountry(roots: AddressNode[], code: string, hits: readonly LandmarkHit[]): void {
	const country = roots.find((root) => root.tag === "country" && typeof root.placeID === "string")

	if (!country) return

	country.metadata = { ...country.metadata, code_collision: isCountryAirportCollision(code) }

	const holders = hits.filter((hit) => hit.code && hit.kind === "venue")

	if (!holders.length) return

	const listed = (country.alternatives as ResolvedPlace[] | undefined) ?? []

	country.alternatives = [...listed, ...holders.map(placeOf)]
}

/**
 * Replaces the parse's reading of a landmark name with a venue node that holds the answer.
 *
 * The first comma-separated part is the name, and any other part is context that has to have resolved.
 * A settlement that leads the name stays with the admin ladder, because the ladder ranks settlements.
 */
export async function applyLandmark(roots: AddressNode[], raw: string, landmarks: LandmarkLookup): Promise<void> {
	const nodes = [...walkNodes(roots)]

	if (nodes.some((node) => ADDRESS_TAGS.has(node.tag))) return

	const name = raw.split(",", 1)[0]!.trim()

	if (!name) return

	const hits = await landmarks.find(name)
	const hasContext = raw.trim().length > name.length

	// A bare country code answers the country, and the airport holding the same code is listed beside it.
	// The registry's collision verdict is stamped whether or not the landmark layer holds the code.
	// With context, `FRA, Germany` can still reach the airport.
	if (!hasContext && writtenCountryCode(name)) {
		listCodeHoldersOnCountry(roots, name, hits)

		return
	}

	if (!hits.length) return

	const nameEnd = raw.indexOf(name) + name.length
	const context = roots.filter((node) => node.start >= nameEnd && typeof node.placeID === "string")

	if (hasContext && !context.length) return

	const candidates = hasContext ? hitsInContext(hits, context) : hits
	const leader = candidates[0]

	if (!leader || leader.kind !== "venue") return

	// A translation or alias is the weakest claim on a name, so it answers only where the
	// gazetteer holds none: `Hamburg` is an alias of Hamburg Airport and the name of a city.
	const resolved = roots.filter((root) => typeof root.placeID === "string")
	const fromOSM = leader.qid.startsWith(OSM_LANDMARK_PREFIX)

	if (fromOSM) {
		// A school or a park in OpenStreetMap can share its town's name,
		// so a place holding the whole name keeps it.
		// `Piedmont Park` is free to answer, because the walk resolved only `Piedmont`.
		// A row with no measured population yields, as `Piedmont Park` in South
		// Carolina yields to the park in Atlanta.
		const holdsName = (node: AddressNode) =>
			typeof node.placeID === "string" &&
			foldName(node.value) === foldName(name) &&
			Number(node.metadata?.["resolver_score"] ?? 0) > 0

		if (nodes.some(holdsName)) return
	} else {
		const nameResolved = resolved.some(
			(root) => root.start < nameEnd || root.value.toLowerCase() === name.toLowerCase()
		)

		if (!leader.primary && !leader.code && nameResolved) return
	}

	const node: AddressNode = {
		tag: "venue",
		value: name.normalize("NFC").replaceAll(/\s+/gu, " "),
		start: raw.indexOf(name),
		end: nameEnd,
		confidence: 1,
		children: [],
	}

	decorateNode(node, placeOf(leader), candidates.slice(1, LISTED_ALTERNATIVES + 1).map(placeOf))
	node.placeID = landmarkPlaceID(leader.qid)

	node.metadata = {
		...node.metadata,
		landmark_sitelinks: leader.sitelinks,
		...(fromOSM ? { landmark_source: "openstreetmap:planet" } : {}),
	}

	roots.splice(0, roots.length, node, ...context)
}
