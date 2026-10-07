/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { ResolutionTier } from "@mailwoman/annotations/geo"
import { slotNodes, decodeAsJSON, type AddressNode, type AddressTree } from "@mailwoman/core/decoder"
import type { GeocodeResult, UnfollowedComponent } from "@mailwoman/core/geocode"
import { adminLadderForNodes } from "@mailwoman/resolver"

import { adminCoherenceField } from "#admin-coherence"
import { epistemicStatusFor } from "#geocode/epistemic-status"
import { capitalPromotionOf, postcodeCountryScopeOf, variantAliasExemptionOf } from "#geocode/tree-reads"
import { assembleHierarchy, lineageAnchorNode } from "#hierarchy-lineage"
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

function unfollowedComponents(allNodes: readonly AddressNode[]): UnfollowedComponent[] {
	const refusedKm = allNodes
		.map((node) => node.metadata?.["postcode_move_refused_km"])
		.find((km): km is number => typeof km === "number")

	if (refusedKm === undefined) return []

	const postcode = allNodes.find((node) => node.tag === "postcode")

	if (!postcode) return []

	return [{ tag: "postcode", value: postcode.value, reason: "postcode_move_refused", distance_km: refusedKm }]
}

/**
 * Projects a resolved address tree into a geocode result.
 *
 * The coordinate comes from the most precise tier present, in the order address point,
 * interpolated point, street centroid and admin ladder.
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

	let adminWinnerNode: AddressNode | null = null

	if (streetNode?.metadata?.["resolution_tier"] === "address_point") {
		const ap = streetNode.metadata["address_point"] as
			| { lat: number; lon: number; locality_norm?: string; postcode?: string; basis?: string }
			| undefined

		if (ap) {
			lat = ap.lat
			lon = ap.lon
			tier = "address_point"
			uncertaintyM = 1
			answeringBasis = ap.basis ?? null

			if (ap.locality_norm || ap.postcode) {
				rooftop = {
					localityNorm: ap.locality_norm || null,
					postcode: ap.postcode || null,
				}
			}
		}
	}

	if (tier !== "address_point" && streetNode?.metadata?.["resolution_tier"] === "interpolated") {
		const ip = streetNode.metadata["interpolated_point"] as { lat: number; lon: number } | undefined

		if (ip) {
			lat = ip.lat
			lon = ip.lon
			tier = "interpolated"
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

	const hierarchy = assembleHierarchy(allNodes, streetLocality, adminWinnerNode ?? lineageAnchorNode(allNodes))

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

		admin_coherence: adminCoherenceField(allNodes, adminWinnerNode, primaryNode),
		postcode_country_scope: postcodeCountryScopeOf(tree) ?? null,
		capital_promotion: capitalPromotionOf(tree),
		variant_alias_exemption: variantAliasExemptionOf(tree) === true ? true : null,

		intent_markers: [],
		derivation: null,
		entity: null,
		authoritative: null,
	}

	return extracted
}
