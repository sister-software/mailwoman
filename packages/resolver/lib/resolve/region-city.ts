/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { walkNodes, type AddressNode } from "@mailwoman/core/decoder"
import type { ResolverBackend } from "@mailwoman/core/resolver"

import { decorateNode } from "#decorate-node"
import { streetNumberPairs } from "#street/tier"

/**
 * Reads a street address's region as the city of the same name when the
 * gazetteer holds one inside that region.
 *
 * `34 Lê Duẩn, Sài Gòn, Hồ Chí Minh, Vietnam` parses with a region and no locality.
 * The region's point can lie far from the street, and the address-point lookup
 * has no locality to search around.
 *
 * A place held at both levels occurs wherever a city is its own province, so the test reads the hierarchy.
 *
 * A bare region stays a region, because only a street and number say the input
 * means somewhere a street can be.
 */
export async function applyRegionCity(roots: AddressNode[], backend: ResolverBackend): Promise<void> {
	const nodes = [...walkNodes(roots)]

	if (nodes.some((node) => node.tag === "locality") || !streetNumberPairs(roots).length) return

	const region = nodes.find((node) => node.tag === "region" && node.placeID?.startsWith("wof:"))

	if (!region) return

	const [city, ...others] = await backend.findPlace({
		text: region.value,
		placetype: "locality",
		parentID: Number(region.placeID!.slice("wof:".length)),
	})

	// A lookup that finds the name only outside the parent answers with that place and marks the miss.
	if (!city?.exactMatch || city.regionScopeMiss) return

	region.tag = "locality"
	decorateNode(region, city, others)
	region.metadata = { ...region.metadata, region_city: true }
}

/**
 * Reads a locality the gazetteer holds only as a region, inside a country the input states.
 *
 * `Likiep Atoll, RMI` parses the atoll as a locality, and the Marshall Islands hold it as a region.
 * This runs after the locality band missed, so a place with a locality row keeps it.
 */
export async function applyLocalityAsRegion(
	roots: AddressNode[],
	backend: ResolverBackend,
	country: string
): Promise<void> {
	const nodes = [...walkNodes(roots)]
	const locality = nodes.find((node) => node.tag === "locality" && !node.placeID && node.value.trim())

	if (!locality || nodes.some((node) => node.tag === "region" && node.placeID)) return

	const [region, ...others] = await backend.findPlace({ text: locality.value, placetype: "region", country })

	if (!region?.exactMatch || region.country !== country) return

	locality.tag = "region"
	decorateNode(locality, region, others)
}
