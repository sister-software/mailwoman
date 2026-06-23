/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for #370 "Lever A" — postcode-disambiguated locality selection
 *   (`opts.postcodeConsistency`). A same-named locality that resolves far from a resolved sibling
 *   postcode is either re-picked from its alternatives (the same-named instance nearest the
 *   postcode) or, if none reconciles, has its coordinate fall back to the postcode point + flagged.
 *   Byte-stable when the flag is unset.
 */

import { describe, expect, it } from "vitest"

import type { AddressNode, AddressTree } from "../decoder/types.js"
import { createWofResolver } from "./resolve.js"
import type { ResolvedPlace, ResolverBackend } from "./types.js"

const PC = {
	id: 900,
	name: "75001",
	placetype: "postalcode",
	country: "FR",
	lat: 48.86,
	lon: 2.35,
	score: 1,
	exactMatch: true,
}
const SP_FAR = {
	id: 1,
	name: "Saint-Pierre",
	placetype: "locality",
	country: "FR",
	lat: 44.0,
	lon: 5.0,
	score: 8,
	exactMatch: true,
} // ~600 km from PC
const SP_NEAR = {
	id: 2,
	name: "Saint-Pierre",
	placetype: "locality",
	country: "FR",
	lat: 48.9,
	lon: 2.4,
	score: 7,
	exactMatch: true,
} // ~6 km from PC

/** A backend that returns the given places in order, filtered by name-substring + placetype +
country. */
function makeBackend(places: ResolvedPlace[]): ResolverBackend {
	return {
		async findPlace(query) {
			const text = query.text.toLowerCase()
			const types = Array.isArray(query.placetype) ? query.placetype : query.placetype ? [query.placetype] : null
			return places
				.filter((p) => p.name.toLowerCase().includes(text))
				.filter((p) => !types || types.includes(p.placetype))
				.filter((p) => !query.country || p.country === query.country)
				.slice(0, query.limit ?? 5)
		},
	}
}

const node = (over: Partial<AddressNode> & Pick<AddressNode, "tag" | "value" | "start" | "end">): AddressNode => ({
	confidence: 0.95,
	children: [],
	...over,
})
const tree = (roots: AddressNode[]): AddressTree => ({ raw: "75001 Saint-Pierre", roots })
const localityNode = () => node({ tag: "locality", value: "Saint-Pierre", start: 6, end: 18 })
const postcodeNode = () => node({ tag: "postcode", value: "75001", start: 0, end: 5 })

describe("resolveTree + postcodeConsistency (Lever A)", () => {
	it("re-picks the same-named locality nearest the postcode (the wrong instance was the top match)", async () => {
		// Backend returns the FAR Saint-Pierre first → top is wrong; the NEAR one is an alternative.
		const resolver = createWofResolver(makeBackend([PC, SP_FAR, SP_NEAR]))
		const out = await resolver.resolveTree(tree([postcodeNode(), localityNode()]), {
			defaultCountry: "FR",
			postcodeConsistency: true,
		})
		const loc = out.roots.find((n) => n.tag === "locality")!
		expect(loc.placeId).toBe("wof:2") // re-picked to the postcode-consistent instance
		expect(loc.lat).toBeCloseTo(48.9)
		expect(loc.metadata?.postcode_repicked).toBe(true)
	})

	it("falls the coordinate back to the postcode when no same-named instance reconciles", async () => {
		// Only the FAR Saint-Pierre exists — no alternative within the gate → demote to the postcode point.
		const resolver = createWofResolver(makeBackend([PC, SP_FAR]))
		const out = await resolver.resolveTree(tree([postcodeNode(), localityNode()]), {
			defaultCountry: "FR",
			postcodeConsistency: true,
		})
		const loc = out.roots.find((n) => n.tag === "locality")!
		expect(loc.lat).toBeCloseTo(48.86) // postcode point
		expect(loc.lon).toBeCloseTo(2.35)
		expect(loc.metadata?.postcode_city_mismatch).toBe(true)
		expect(loc.metadata?.coordinate_source).toBe("postcode_fallback")
	})

	it("leaves a locality already consistent with the postcode untouched", async () => {
		// NEAR is the only/top candidate and it's within the gate → no change.
		const resolver = createWofResolver(makeBackend([PC, SP_NEAR]))
		const out = await resolver.resolveTree(tree([postcodeNode(), localityNode()]), {
			defaultCountry: "FR",
			postcodeConsistency: true,
		})
		const loc = out.roots.find((n) => n.tag === "locality")!
		expect(loc.placeId).toBe("wof:2")
		expect(loc.metadata?.postcode_repicked).toBeUndefined()
		expect(loc.metadata?.postcode_city_mismatch).toBeUndefined()
	})

	it("is byte-stable when postcodeConsistency is unset (keeps the wrong top match)", async () => {
		const resolver = createWofResolver(makeBackend([PC, SP_FAR, SP_NEAR]))
		const out = await resolver.resolveTree(tree([postcodeNode(), localityNode()]), { defaultCountry: "FR" })
		const loc = out.roots.find((n) => n.tag === "locality")!
		expect(loc.placeId).toBe("wof:1") // the far one — untouched without the lever
		expect(loc.lat).toBeCloseTo(44.0)
	})

	it("no-ops when no postcode resolved (no anchor to disambiguate against)", async () => {
		// No postcode in the tree → Lever A can't fire; the (wrong) top match stands.
		const resolver = createWofResolver(makeBackend([SP_FAR, SP_NEAR]))
		const out = await resolver.resolveTree(tree([localityNode()]), { defaultCountry: "FR", postcodeConsistency: true })
		const loc = out.roots.find((n) => n.tag === "locality")!
		expect(loc.placeId).toBe("wof:1")
	})
})
