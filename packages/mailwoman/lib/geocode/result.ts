/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { ResolutionTier } from "@mailwoman/annotations/geo"
import { slotNodes, decodeAsJSON, type AddressNode, type AddressTree } from "@mailwoman/core/decoder"
import type { CoordinateSource, GeocodeResult, UnfollowedComponent } from "@mailwoman/core/geocode"
import { adminLadderForNodes } from "@mailwoman/resolver"
import { haversineKm, isLatLonBounds } from "@mailwoman/spatial"

import { adminCoherenceField } from "#admin-coherence"
import { epistemicStatusFor } from "#geocode/epistemic-status"
import { capitalPromotionOf, postcodeCountryScopeOf, variantAliasExemptionOf } from "#geocode/tree-reads"
import { assembleHierarchy, type HierarchySourceNode, lineageAnchorNode } from "#hierarchy-lineage"
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
 * The register row's own provenance stamp and release, or `null` when the tree carries no stamp.
 *
 * The stamp is copied rather than derived, so a row is reported as the source it names and a
 * coordinate whose row named none is reported as unstamped rather than given a guessed source.
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

	return Math.round((haversineKm(minLat, minLon, maxLat, maxLon) * 1000) / 2)
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

	const allNodes = slotNodes(tree.roots)
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

	if (tier === "admin") {
		const adminPriority = adminLadderForNodes(allNodes)

		for (const tag of adminPriority) {
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

	const locality =
		streetLocality ??
		allNodes.find((n) => n.tag === "locality" || n.tag === "dependent_locality")?.value?.trim() ??
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

	const candidates: GeocodeResult["candidates"] = []

	if (primaryNode?.lat != null) {
		const seen = new Set<string>()
		const coordKey = (lt: number, ln: number): string => `${lt.toFixed(4)},${ln.toFixed(4)}`
		seen.add(coordKey(primaryNode.lat, primaryNode.lon!))

		candidates.push({
			name: (primaryNode.metadata?.["resolver_name"] as string | null)?.trim() || primaryNode.value.trim(),
			tag: primaryNode.tag,
			lat: primaryNode.lat,
			lon: primaryNode.lon!,
			countryCode: (primaryNode.metadata?.["resolver_country"] as string | null)?.trim()?.toUpperCase() ?? null,
			placeID: primaryNode.placeID || null,
		})

		const alts =
			(primaryNode.alternatives as ReadonlyArray<{
				name?: string
				placetype?: string
				lat?: number
				lon?: number
				country?: string
				id?: number | string
			}> | null) ?? []

		for (const a of alts) {
			if (a.lat == null || a.lon == null || !a.name) continue
			const key = coordKey(a.lat, a.lon)

			if (seen.has(key)) continue
			seen.add(key)

			candidates.push({
				name: String(a.name).trim(),
				tag: a.placetype ?? primaryNode.tag,
				lat: a.lat,
				lon: a.lon,
				countryCode: a.country ? String(a.country).trim().toUpperCase() : null,
				placeID: a.id != null ? `wof:${a.id}` : null,
			})
		}
	}

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
		entity: null,
		authoritative: null,
	}

	return extracted
}
