/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { walkNodes, type AddressNode } from "@mailwoman/core/decoder"
import type { ResolverBackend } from "@mailwoman/core/resolver"
import { haversine } from "@mailwoman/spatial/geometries/point/distance"

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
 *
 * A locality the gazetteer did not resolve leaves the region as the only place,
 * and Bristol's region point lies in the Bristol Channel, so the city answers there too.
 */
export async function applyRegionCity(roots: AddressNode[], backend: ResolverBackend): Promise<void> {
	const nodes = [...walkNodes(roots)]

	if (nodes.some((node) => node.tag === "locality" && node.placeID) || !streetNumberPairs(roots).length) return

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

/**
 * Reads a country as the region of the same name when only that region holds the stated town.
 *
 * `Savannah, Georgia` parses `Georgia` as the country, and the country holds no Savannah.
 * `Tbilisi, Georgia` keeps the country, because the country holds Tbilisi.
 *
 * A caller's US scope leaves the country of Georgia unresolved, so that node has no country to test against.
 */
export async function applyCountryAsRegion(roots: AddressNode[], backend: ResolverBackend): Promise<void> {
	const nodes = [...walkNodes(roots)]
	const country = nodes.find((node) => node.tag === "country" && node.value.trim())
	const locality = nodes.find((node) => node.tag === "locality" && node.value.trim())

	if (!country || !locality || nodes.some((node) => node.tag === "region")) return

	const stated = country.metadata?.["resolver_country"]

	if (typeof stated === "string") {
		const [local] = await backend.findPlace({ text: locality.value, placetype: "locality", country: stated })

		if (local?.exactMatch) return
	}

	for (const region of await backend.findPlace({ text: country.value, placetype: "region" })) {
		if (!region.exactMatch) continue

		const [city, ...others] = await backend.findPlace({
			text: locality.value,
			placetype: "locality",
			parentID: region.id,
		})

		if (!city?.exactMatch || city.regionScopeMiss) continue

		country.tag = "region"
		decorateNode(country, region, [])
		decorateNode(locality, city, others)

		return
	}
}

/**
 * The tags whose spans together write a street's name.
 */
const STREET_PART_TAGS: ReadonlySet<string> = new Set([
	"street_prefix",
	"street_prefix_particle",
	"street",
	"street_suffix",
])

/**
 * How far a town may sit from the stated postcode's point and still be the place the postcode serves.
 */
const TOWN_POSTCODE_REACH_KM = 15

/**
 * Removes the given nodes wherever they sit in the tree.
 */
function removeNodes(list: AddressNode[], drop: ReadonlySet<AddressNode>): void {
	for (let index = list.length - 1; index >= 0; index--) {
		const node = list[index]!

		if (drop.has(node)) {
			list.splice(index, 1)
		} else if (node.children?.length) {
			removeNodes(node.children, drop)
		}
	}
}

/**
 * Reads an unnumbered street as the town of that name when the town holds the stated postcode.
 *
 * `Alameda, CA 94501` and `Crocketts Bluff, AR 72038` parse the town as a street,
 * because a name before a region and postcode is where a street sits in a full address.
 * A street name and a town name agree this close to the postcode's point only when they
 * name one place, so a real street such as `Main Street, CA 94501` keeps its tag.
 */
export async function applyStreetAsTown(roots: AddressNode[], backend: ResolverBackend): Promise<void> {
	const nodes = [...walkNodes(roots)]
	const parts = nodes.filter((node) => STREET_PART_TAGS.has(node.tag)).toSorted((a, b) => a.start - b.start)
	const postcode = nodes.find((node) => node.tag === "postcode" && node.lat != null && node.lon != null)

	if (!parts.some((node) => node.tag === "street") || !postcode) return

	if (nodes.some((node) => node.tag === "house_number" || node.tag === "locality" || node.tag === "venue")) return

	const region = nodes.find((node) => node.tag === "region" && node.placeID?.startsWith("wof:"))
	const country = postcode.metadata?.["resolver_country"]

	if (!region && typeof country !== "string") return

	const name = parts.map((node) => node.value.trim()).join(" ")

	const [town, ...others] = await backend.findPlace({
		text: name,
		placetype: "locality",
		...(region ? { parentID: Number(region.placeID!.slice("wof:".length)) } : { country: country as string }),
	})

	if (!town?.exactMatch || town.regionScopeMiss || town.lat == null || town.lon == null) return

	if (haversine(postcode.lat!, postcode.lon!, town.lat, town.lon, "km") > TOWN_POSTCODE_REACH_KM) return

	const [first, ...rest] = parts

	first!.tag = "locality"
	first!.value = name
	first!.end = parts.at(-1)!.end
	removeNodes(roots, new Set(rest))
	decorateNode(first!, town, others)
	first!.metadata = { ...first!.metadata, street_as_town: true }
}

/**
 * Reads a venue as a town when the input states only a country beside it
 * and the country holds a town of that name.
 *
 * `Road Town, British Virgin Islands` parses the town as a venue.
 * This runs ahead of the landmark layer, so an airport alias under `Biggin Hill`
 * yields to the town that holds the name.
 */
export async function applyVenueAsTown(roots: AddressNode[], backend: ResolverBackend): Promise<void> {
	const nodes = [...walkNodes(roots)]
	const venue = nodes.find((node) => node.tag === "venue" && !node.placeID && node.value.trim())

	const country = nodes.find(
		(node) => node.tag === "country" && typeof node.metadata?.["resolver_country"] === "string"
	)

	if (!venue || !country || nodes.some((node) => node !== venue && node !== country)) return

	const [town, ...others] = await backend.findPlace({
		text: venue.value,
		placetype: "locality",
		country: country.metadata!["resolver_country"] as string,
	})

	if (!town?.exactMatch) return

	venue.tag = "locality"
	decorateNode(venue, town, others)
}
