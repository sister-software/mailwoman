/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for the #833 forward `country_hint` linkage. A region node carrying `metadata.country_hint`
 *   (an address-system recognizer's derived country — `recognizeUsRegions` stamps "US" on a 2-letter US
 *   state abbrev) constrains THAT node's lookup to the hinted country, below a resolved parent's country
 *   but above the global defaults. It breaks the two-consistent-pairs tie ("Augusta, ME" → Maine, not
 *   the more-populous Augusta under Messina) that geographic consistency alone cannot.
 */

import type { AddressNode, AddressTree } from "@mailwoman/core/decoder"
import type { ResolvedPlace, ResolverBackend } from "@mailwoman/core/resolver"
import { describe, expect, it } from "vitest"

import { createWofResolver } from "./resolve.js"

const MESSINA = {
	id: 10,
	name: "Messina",
	placetype: "region",
	country: "IT",
	lat: 38.0,
	lon: 14.9,
	score: 9,
	exactMatch: true,
}
const MAINE = {
	id: 20,
	name: "Maine",
	placetype: "region",
	country: "US",
	lat: 45.3,
	lon: -69.0,
	score: 7,
	exactMatch: true,
}
const AUGUSTA_ME: ResolvedPlace = {
	id: 21,
	name: "Augusta",
	placetype: "locality",
	country: "US",
	parent_id: 20,
	lat: 44.31,
	lon: -69.78,
	score: 8,
	exactMatch: true,
}
const AUGUSTA_IT: ResolvedPlace = {
	id: 11,
	name: "Augusta",
	placetype: "locality",
	country: "IT",
	parent_id: 10,
	lat: 37.2,
	lon: 15.2,
	score: 9,
	exactMatch: true,
}

/** Backend filtered by name + placetype + country + parentId. Regions match any 2-letter token (abbrev). */
function makeBackend(places: ResolvedPlace[]): ResolverBackend {
	return {
		async findPlace(query) {
			const text = query.text.toLowerCase()
			const types = Array.isArray(query.placetype) ? query.placetype : query.placetype ? [query.placetype] : null

			return places
				.filter((p) => p.name.toLowerCase() === text || (p.placetype === "region" && text.length === 2))
				.filter((p) => !types || types.includes(p.placetype))
				.filter((p) => !query.country || p.country === query.country)
				.filter((p) => query.parentId === undefined || p.parent_id === query.parentId)
				.slice(0, query.limit ?? 5)
		},
	}
}

const node = (over: Partial<AddressNode> & Pick<AddressNode, "tag" | "value" | "start" | "end">): AddressNode => ({
	confidence: 0.95,
	children: [],
	...over,
})
// region(ME) → locality(Augusta), with the hint set or not.
const augustaMeTree = (hint: boolean): AddressTree => ({
	raw: "Augusta, ME",
	roots: [
		node({
			tag: "region",
			value: "ME",
			start: 9,
			end: 11,
			...(hint ? { metadata: { country_hint: "US" } } : {}),
			children: [node({ tag: "locality", value: "Augusta", start: 0, end: 7 })],
		}),
	],
})

function localityOf(tree: AddressTree): AddressNode | undefined {
	const stack = [...tree.roots]

	while (stack.length) {
		const n = stack.pop()!

		if (n.tag === "locality") return n
		stack.push(...n.children)
	}

	return undefined
}

describe("resolveTree + country_hint (#833 forward linkage)", () => {
	it("pins a hinted region to its country → the US locality wins the two-pairs tie", async () => {
		const resolver = createWofResolver(makeBackend([MESSINA, MAINE, AUGUSTA_ME, AUGUSTA_IT]))
		const out = await resolver.resolveTree(augustaMeTree(true), {})
		const loc = localityOf(out)

		// region "ME" constrained to US → Maine; Augusta scopes to Maine → Augusta, Maine (not Sicily).
		expect(loc?.lat).toBeCloseTo(44.31, 2)
		expect(loc?.lon).toBeCloseTo(-69.78, 2)
	})

	it("without the hint, the greedy region (more-populous Messina) wins and Augusta lands in Sicily", async () => {
		const resolver = createWofResolver(makeBackend([MESSINA, MAINE, AUGUSTA_ME, AUGUSTA_IT]))
		const out = await resolver.resolveTree(augustaMeTree(false), {})
		const loc = localityOf(out)

		expect(loc?.lat).toBeCloseTo(37.2, 1)
		expect(loc?.lon).toBeCloseTo(15.2, 1)
	})
})
