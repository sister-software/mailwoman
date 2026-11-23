// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import type { ResolutionTier } from "@mailwoman/annotations/geo"
import { slotNodes, decodeAsJSON, type AddressNode, type AddressTree } from "@mailwoman/core/decoder"
import type { CoordinateSource, GeocodeCandidate, GeocodeResult, UnfollowedComponent } from "@mailwoman/core/geocode"
import { landmarkPlaceID, ScoreUnmeasuredReason } from "@mailwoman/core/resolver"
import { isPresent } from "@mailwoman/core/values/objects"
import { computeQueryShape } from "@mailwoman/postcode/recognizer/query-shape"
import { adminLadderForNodes, ladderWithContainedDependentLocality } from "@mailwoman/resolver"
import { normalizeLocalityForKey } from "@mailwoman/resolver-wof-sqlite/street"
import { isLatLonBounds } from "@mailwoman/spatial/bbox"
import { haversine } from "@mailwoman/spatial/geometries/point/distance"

import { adminCoherenceField } from "#geocode/result/admin-coherence"
import { epistemicStatusFor } from "#geocode/result/epistemic-status"
import { assembleHierarchy, type HierarchySourceNode, lineageAnchorNode } from "#geocode/result/hierarchy-lineage"
import { capitalPromotionOf, postcodeCountryScopeOf, variantAliasExemptionOf } from "#geocode/tree-reads"
import { assembleStreetName } from "#street/name-assembly"

/**
 * The node the resolver labeled at the answer's coordinate, else the first
 * resolver-labeled node with a coordinate.
 */
function resolverNamedNode(
	allNodes: readonly AddressNode[],
	lat: number | null,
	lon: number | null
): AddressNode | null {
	return (
		allNodes.find((n) => n.metadata?.["resolver_name"] && n.lat === lat && n.lon === lon) ??
		allNodes.find((n) => n.metadata?.["resolver_name"] && n.lat != null) ??
		null
	)
}

function hierarchySourceNodeOf(node: AddressNode): HierarchySourceNode {
	return {
		tag: node.tag,
		value: node.value,
		lat: node.lat ?? null,
		lon: node.lon ?? null,
		placeID: node.placeID ?? null,
		metadata: node.metadata ?? null,
	}
}

function unfollowedComponents(allNodes: readonly AddressNode[]): UnfollowedComponent[] {
	const unfollowed: UnfollowedComponent[] = []

	const refusedKm = allNodes
		.map((node) => node.metadata?.["postcode_move_refused_km"])
		.find((km) => typeof km === "number")

	const postcode = allNodes.find((node) => node.tag === "postcode")

	if (typeof refusedKm === "number" && postcode) {
		unfollowed.push({ tag: "postcode", value: postcode.value, reason: "postcode_move_refused", distance_km: refusedKm })
	}

	for (const node of allNodes) {
		const outsideKm = node.metadata?.["rooftop_outside_locality_km"]

		if (typeof outsideKm === "number") {
			unfollowed.push({ tag: node.tag, value: node.value, reason: "rooftop_outside_locality", distance_km: outsideKm })
		}
	}

	return unfollowed
}

/**
 * The coordinate and provenance the street tier writes for an address-point or interpolated hit.
 */
interface RegisterRowPoint {
	lat: number
	lon: number
	source?: unknown
	release?: unknown
}

/**
 * The register row's own provenance stamp and release, or `null` when the tree has no stamp.
 *
 * The stamp is copied rather than derived, so a row is reported as its recorded source.
 * A coordinate with no recorded source is reported as unstamped rather than given a guessed source.
 */
function coordinateSourceOf(point: RegisterRowPoint): CoordinateSource | null {
	if (typeof point.source !== "string" || !point.source) return null

	return { source: point.source, release: typeof point.release === "string" ? point.release : null }
}

/**
 * Half the diagonal of a resolved place's bounding box, in meters, or `null`
 * when the resolver recorded no extent for the place.
 */
function halfDiagonalM(bbox: unknown): number | null {
	if (!isLatLonBounds(bbox)) return null

	const { minLat, minLon, maxLat, maxLon } = bbox

	return Math.round((haversine(minLat, minLon, maxLat, maxLon) * 1000) / 2)
}

/**
 * The admin ladder for a tree, with a dependent locality the resolver placed inside
 * its parent moved ahead of the locality (#2804).
 *
 * The resolver writes the `contained_by_parent` stamp only under its `dependentLocalityContainment`
 * switch, so a tree without the stamp keeps the ladder as it stands.
 */
function adminPriorityFor(allNodes: readonly AddressNode[]): ReadonlyArray<string> {
	const ladder = adminLadderForNodes(allNodes)

	const contained = allNodes.some(
		(n) =>
			n.tag === "dependent_locality" && n.lat != null && n.lon != null && n.metadata?.["contained_by_parent"] === true
	)

	return contained ? ladderWithContainedDependentLocality(ladder) : ladder
}

/**
 * Moves a resolved node made of words from the venue's name behind the other nodes of its tag.
 *
 * A parse can tag a word of a venue's name with the town's tag, as `Federal` in
 * `Federal Building Oxnard Post Office, Oxnard, CA`, and the result reads the first node of each tag.
 * A node moves back when the comma-separated segment holding it also holds the venue
 * and the node's value differs from every whole segment of the input.
 *
 * A node in a segment without a venue keeps its place, as `Barcelona` in `Barcelona 6001`
 * keeps its place ahead of a state that the parse tagged as a locality.
 *
 * Each node keeps a position its tag already held, so the order between tags is unchanged.
 */
function venueWordsLast(nodes: readonly AddressNode[], input: string): AddressNode[] {
	const segments = computeQueryShape(input)
		.segments.map(({ body }) => normalizeLocalityForKey(body))
		.filter(isPresent)

	const venues = nodes
		.filter((node) => node.tag === "venue")
		.map((node) => normalizeLocalityForKey(node.value))
		.filter(isPresent)

	if (!venues.length) return [...nodes]

	const isVenueWord = (node: AddressNode): boolean => {
		const key = normalizeLocalityForKey(node.value)

		if (!key || segments.includes(key)) return false

		return segments.some((body) => body.includes(key) && venues.some((venue) => body.includes(venue)))
	}

	const reordered = [...nodes]

	for (const tag of new Set(nodes.map((node) => node.tag))) {
		const positions = nodes.flatMap((node, index) => (node.tag === tag && node.lat != null ? [index] : []))

		if (positions.length < 2) continue

		const members = positions.map((index) => nodes[index]!)
		const ordered = [...members.filter((node) => !isVenueWord(node)), ...members.filter(isVenueWord)]

		positions.forEach((index, i) => {
			reordered[index] = ordered[i]!
		})
	}

	return reordered
}

/**
 * A candidate's score, or null with the reason the score is unmeasured.
 *
 * The resolver keeps an unmeasured score as a ranking key, so the reason decides before the value does.
 */
function scoreFieldsOf(value: unknown, unmeasured: unknown): Pick<GeocodeCandidate, "score" | "scoreUnmeasured"> {
	if (typeof unmeasured === "string") {
		return { score: null, scoreUnmeasured: unmeasured as ScoreUnmeasuredReason }
	}

	return typeof value === "number" && Number.isFinite(value)
		? { score: value }
		: { score: null, scoreUnmeasured: ScoreUnmeasuredReason.Unrecorded }
}

/**
 * The fields of a resolver alternative the candidate list reads.
 */
interface CandidateAlternative {
	name?: string
	placetype?: string
	lat?: number
	lon?: number
	country?: string | null
	id?: number | string
	score?: number
	scoreUnmeasured?: ScoreUnmeasuredReason | null
	matchedAlias?: true | null
	outsideScope?: true | null
}

/**
 * The most places the candidate list reports for one parsed span, its winner included.
 *
 * A default lookup retrieves 5 rows and the bare-toponym race probes 2 more,
 * so 10 holds every place a default lookup weighed plus one re-pick's displaced place.
 * A caller that raises the retrieval count past that sees the span's top 10.
 */
const CANDIDATES_PER_SPAN = 10

/**
 * The most places the candidate list reports across all spans.
 *
 * It bounds the response for an input with several resolved spans: the primary span's
 * 10 plus up to 15 places from the region, county and postcode spans beside it.
 */
const CANDIDATE_LIMIT = 25

/**
 * The places the resolver weighed, grouped by parsed span: the primary node's winner
 * and the places it passed over, then the passed-over places of every other resolved node.
 *
 * Within a span, the ranked runner-ups (`alternatives`) precede the probe losers
 * and replaced places (`considered`), each in the order the resolver kept them.
 * A place reported under an earlier span is skipped by place ID.
 *
 * A synthetic place without an ID is skipped by coordinate instead.
 *
 * A primary node without a coordinate answers an empty list.
 */
function candidatesOf(primaryNode: AddressNode | null, allNodes: readonly AddressNode[]): GeocodeCandidate[] {
	if (primaryNode?.lat == null || primaryNode.lon == null) return []

	const metadata = primaryNode.metadata ?? {}
	const winnerPlacetype = primaryNode.sourceID?.split(":")[0] || primaryNode.tag

	const candidates: GeocodeCandidate[] = [
		{
			name: (metadata["resolver_name"] as string | null)?.trim() || primaryNode.value.trim(),
			tag: primaryNode.tag,
			value: primaryNode.value,
			placetype: winnerPlacetype,
			lat: primaryNode.lat,
			lon: primaryNode.lon,
			countryCode: (metadata["resolver_country"] as string | null)?.trim()?.toUpperCase() ?? null,
			placeID: primaryNode.placeID || null,
			...scoreFieldsOf(metadata["resolver_score"], metadata["resolver_score_unmeasured"]),
			...(metadata["resolver_matched_alias"] ? { matchedAlias: true as const } : {}),
		},
	]

	const seen = new Set([primaryNode.placeID || `${primaryNode.lat},${primaryNode.lon}`])

	const spans = [primaryNode, ...allNodes.filter((n) => n !== primaryNode && n.lat != null && n.lon != null)]

	for (const node of spans) {
		let listed = node === primaryNode ? 1 : 0

		const weighed = [...(node.alternatives ?? []), ...(node.considered ?? [])] as ReadonlyArray<CandidateAlternative>

		for (const a of weighed) {
			if (listed === CANDIDATES_PER_SPAN || candidates.length === CANDIDATE_LIMIT) break

			if (a.lat == null || a.lon == null || !a.name) continue

			const hasID = a.id != null && a.id !== 0 && a.id !== ""
			const placeID = hasID ? (a.placetype === "venue" ? landmarkPlaceID(a.id!) : `wof:${a.id}`) : null
			const key = placeID ?? `${a.lat},${a.lon}`

			if (seen.has(key)) continue

			seen.add(key)

			listed++

			candidates.push({
				name: String(a.name).trim(),
				tag: node.tag,
				value: node.value,
				placetype: a.placetype || node.tag,
				lat: a.lat,
				lon: a.lon,
				countryCode: a.country ? String(a.country).trim().toUpperCase() : null,
				placeID,
				...scoreFieldsOf(a.score, a.scoreUnmeasured),
				...(a.matchedAlias ? { matchedAlias: true as const } : {}),
				...(a.outsideScope ? { outsideScope: true as const } : {}),
			})
		}
	}

	return candidates
}

/**
 * Projects a resolved address tree into a geocode result.
 *
 * The coordinate comes from the most precise tier present, in the order address point,
 * interpolated point, street centroid and admin ladder.
 * An admin-ladder coordinate taken from the postcode node reports the `postcode` tier.
 */
export function extractGeocodeResult(input: string, tree: AddressTree): GeocodeResult {
	const projected = decodeAsJSON(tree, { includeDropped: true })
	const { dropped, ...components } = projected

	const allNodes = venueWordsLast(slotNodes(tree.roots), input)
	const unfollowed = unfollowedComponents(allNodes)

	const streetNode = allNodes.find((n) => n.tag === "street")

	let lat: number | null = null
	let lon: number | null = null
	let tier: ResolutionTier = "admin"
	let uncertaintyM: number | null = null

	let rooftop: { localityNorm: string | null; postcode: string | null } | null = null

	let answeringBasis: string | null = null

	let coordinateSource: CoordinateSource | null = null

	let adminWinnerNode: AddressNode | null = null

	if (streetNode?.metadata?.["resolution_tier"] === "address_point") {
		const ap = streetNode.metadata["address_point"] as
			| (RegisterRowPoint & { locality_norm?: string; postcode?: string; basis?: string })
			| undefined

		if (ap) {
			lat = ap.lat
			lon = ap.lon
			tier = "address_point"
			uncertaintyM = 1
			answeringBasis = ap.basis ?? null
			coordinateSource = coordinateSourceOf(ap)

			if (ap.locality_norm || ap.postcode) {
				rooftop = {
					localityNorm: ap.locality_norm || null,
					postcode: ap.postcode || null,
				}
			}
		}
	}

	if (tier !== "address_point" && streetNode?.metadata?.["resolution_tier"] === "interpolated") {
		const ip = streetNode.metadata["interpolated_point"] as RegisterRowPoint | undefined

		if (ip) {
			lat = ip.lat
			lon = ip.lon
			tier = "interpolated"
			coordinateSource = coordinateSourceOf(ip)
			uncertaintyM = (streetNode.metadata["uncertainty_m"] as number | null) ?? null
		}
	}

	if (tier !== "address_point" && tier !== "interpolated" && streetNode?.metadata?.["resolution_tier"] === "street") {
		const sc = streetNode.metadata["street_centroid"] as { lat: number; lon: number } | undefined

		if (sc) {
			lat = sc.lat
			lon = sc.lon
			tier = "street"
			uncertaintyM = (streetNode.metadata["uncertainty_m"] as number | null) ?? null
		}
	}

	// A landmark answer is its own place, finer than any admin node the input states beside it.
	const landmarkNode = allNodes.find((n) => typeof n.metadata?.["landmark_sitelinks"] === "number")

	if (tier === "admin" && landmarkNode) {
		lat = landmarkNode.lat ?? null
		lon = landmarkNode.lon ?? null
		tier = "venue"

		coordinateSource = {
			source: (landmarkNode.metadata?.["landmark_source"] as string | undefined) ?? "wikidata",
			release: null,
		}
	}

	if (tier === "admin") {
		for (const tag of adminPriorityFor(allNodes)) {
			const node = allNodes.find((n) => n.tag === tag && n.lat != null && n.lon != null)

			if (node) {
				lat = node.lat!
				lon = node.lon!
				adminWinnerNode = node

				break
			}
		}

		// A coordinate from the postcode's own row locates the postcode.
		// A postcode is finer than its locality.
		if (adminWinnerNode?.tag === "postcode") {
			tier = "postcode"
			uncertaintyM = halfDiagonalM(adminWinnerNode.metadata?.["resolver_bbox"])
		}
	}

	const streetLocality =
		tier === "street" ? (streetNode?.metadata?.["street_locality"] as string | null)?.trim() || null : null

	// The locality field holds the town, so a district written ahead of it fills the field only when no town is stated.
	const locality =
		streetLocality ??
		(
			allNodes.find((n) => n.tag === "locality") ?? allNodes.find((n) => n.tag === "dependent_locality")
		)?.value?.trim() ??
		null

	const region = allNodes.find((n) => n.tag === "region")?.value?.trim() || null
	const postcode = allNodes.find((n) => n.tag === "postcode")?.value?.trim() || null

	const houseNumber = allNodes.find((n) => n.tag === "house_number")?.value?.trim() || null
	const street = streetNode ? assembleStreetName(streetNode) || null : null

	let countryCode: string | null = null

	for (const n of allNodes) {
		const c = (n.metadata?.["resolver_country"] as string | null)?.trim()

		if (c) {
			countryCode = c.toUpperCase()

			break
		}
	}

	const primaryNode = resolverNamedNode(allNodes, lat, lon)

	const sourceNodes = allNodes.map(hierarchySourceNodeOf)

	const hierarchy = assembleHierarchy(
		sourceNodes,
		streetLocality,
		adminWinnerNode ? hierarchySourceNodeOf(adminWinnerNode) : lineageAnchorNode(sourceNodes)
	)

	const candidates = candidatesOf(primaryNode, allNodes)

	const extracted: GeocodeResult = {
		input,
		components,
		dropped_components: dropped?.length ? dropped : null,
		unfollowed_components: unfollowed.length ? unfollowed : null,
		lat,
		lon,
		resolution_tier: tier,
		epistemic_status: epistemicStatusFor(tier, lat, answeringBasis),
		uncertainty_m: uncertaintyM,
		locality,
		region,
		postcode,
		house_number: houseNumber,
		street,
		venue: allNodes.find((n) => n.tag === "venue")?.value ?? null,
		dependent_locality: allNodes.find((n) => n.tag === "dependent_locality")?.value?.trim() || null,
		unit: allNodes.find((n) => n.tag === "unit")?.value?.trim() || null,
		countryCode,
		hierarchy,
		candidates,
		rooftop,
		coordinate_source: coordinateSource,

		admin_coherence: adminCoherenceField(allNodes, adminWinnerNode, primaryNode),
		postcode_country_scope: postcodeCountryScopeOf(tree) ?? null,
		capital_promotion: capitalPromotionOf(tree),
		variant_alias_exemption: variantAliasExemptionOf(tree),

		intent_markers: [],
		derivation: null,
		entity:
			tier === "venue" && landmarkNode
				? {
						name: (landmarkNode.metadata?.["resolver_name"] as string | undefined) ?? landmarkNode.value,
						categoryID: null,
						confidence: 1,
						country: countryCode ?? "",
					}
				: null,
		authoritative: null,
	}

	return extracted
}
