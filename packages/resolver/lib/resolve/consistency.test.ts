/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for postcode-disambiguated locality selection (`opts.postcodeConsistency`). A locality
 *   that resolves far from a resolved sibling postcode is re-picked from its alternatives, or its
 *   coordinate falls back to the postcode point and is flagged. Byte-stable when the flag is unset.
 */

import type { AddressNode, AddressTree } from "@mailwoman/core/decoder"
import { EMPTY_PLACE_FIELDS } from "@mailwoman/core/resolver"
import type { ResolvedPlace, ResolverBackend } from "@mailwoman/core/resolver"
import { describe, expect, it } from "vitest"

import { createWOFResolver, DEFAULT_POSTCODE_MAX_MOVE_KM } from "#resolve"

const PC = {
	...EMPTY_PLACE_FIELDS,
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
	...EMPTY_PLACE_FIELDS,
	id: 1,
	name: "Saint-Pierre",
	placetype: "locality",
	country: "FR",
	lat: 44,
	lon: 5,
	score: 8,
	exactMatch: true,
}

// ~600 km from PC
const SP_NEAR = {
	...EMPTY_PLACE_FIELDS,
	id: 2,
	name: "Saint-Pierre",
	placetype: "locality",
	country: "FR",
	lat: 48.9,
	lon: 2.4,
	score: 7,
	exactMatch: true,
}

// ~6 km from PC

/**
 * A backend that filters the given places by name substring, placetype and country.
 */
async function makeBackend(places: ResolvedPlace[]): Promise<ResolverBackend> {
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

describe("resolveTree + postcodeConsistency (Change A)", () => {
	it("re-picks the same-named locality nearest the postcode (the wrong instance was the top match)", async () => {
		const resolver = createWOFResolver(await makeBackend([PC, SP_FAR, SP_NEAR]))

		const out = await resolver.resolveTree(tree([postcodeNode(), localityNode()]), {
			defaultCountry: { country: "FR", source: "caller" },
			postcodeConsistency: true,
		})

		const loc = out.roots.find((n) => n.tag === "locality")!
		expect(loc.placeID).toBe("wof:2") // re-picked to the postcode-consistent instance
		expect(loc.lat).toBeCloseTo(48.9)
		expect(loc.metadata?.postcode_repicked).toBe(true)
	})

	it("falls the coordinate back to the postcode when no same-named instance reconciles", async () => {
		const resolver = createWOFResolver(await makeBackend([PC, SP_FAR]))

		const out = await resolver.resolveTree(tree([postcodeNode(), localityNode()]), {
			defaultCountry: { country: "FR", source: "caller" },
			postcodeConsistency: true,
			postcodeConsistencyMaxMoveKm: Infinity,
		})

		const loc = out.roots.find((n) => n.tag === "locality")!
		expect(loc.lat).toBeCloseTo(48.86) // postcode point
		expect(loc.lon).toBeCloseTo(2.35)
		expect(loc.metadata?.postcode_city_mismatch).toBe(true)
		expect(loc.metadata?.coordinate_source).toBe("postcode_fallback")
	})

	it("refuses the fallback past postcodeConsistencyMaxMoveKm and keeps the selected locality", async () => {
		const resolver = createWOFResolver(await makeBackend([PC, SP_FAR]))

		const out = await resolver.resolveTree(tree([postcodeNode(), localityNode()]), {
			defaultCountry: { country: "FR", source: "caller" },
			postcodeConsistency: true,
			postcodeConsistencyMaxMoveKm: 200,
		})

		const loc = out.roots.find((n) => n.tag === "locality")!
		expect(loc.placeID).toBe("wof:1")
		expect(loc.lat).toBeCloseTo(44)
		expect(loc.lon).toBeCloseTo(5)
		expect(loc.metadata?.postcode_city_mismatch).toBe(true)
		expect(loc.metadata?.coordinate_source).toBeUndefined()
		expect(loc.metadata?.postcode_move_refused_km).toBeGreaterThan(200)
	})

	it("DEFAULTS the cap to 300 km, so an unset option refuses this 577 km move", async () => {
		const resolver = createWOFResolver(await makeBackend([PC, SP_FAR]))

		const out = await resolver.resolveTree(tree([postcodeNode(), localityNode()]), {
			defaultCountry: { country: "FR", source: "caller" },
			postcodeConsistency: true,
		})

		const loc = out.roots.find((n) => n.tag === "locality")!

		expect(loc.placeID).toBe("wof:1")
		expect(loc.metadata?.postcode_city_mismatch).toBe(true)
		expect(loc.metadata?.coordinate_source).toBeUndefined()
		expect(loc.metadata?.postcode_move_refused_km).toBeGreaterThan(DEFAULT_POSTCODE_MAX_MOVE_KM)
	})

	it("admits the fallback when the move is inside the cap", async () => {
		const resolver = createWOFResolver(await makeBackend([PC, SP_FAR]))

		const out = await resolver.resolveTree(tree([postcodeNode(), localityNode()]), {
			defaultCountry: { country: "FR", source: "caller" },
			postcodeConsistency: true,
			postcodeConsistencyMaxMoveKm: 1000,
		})

		const loc = out.roots.find((n) => n.tag === "locality")!
		expect(loc.lat).toBeCloseTo(48.86)
		expect(loc.metadata?.coordinate_source).toBe("postcode_fallback")
		expect(loc.metadata?.postcode_move_refused_km).toBeUndefined()
	})

	it("a cap never blocks the re-pick, which moves to a same-named instance rather than the postcode", async () => {
		// A re-pick chooses among the locality's own alternatives, so it cannot
		// produce an id or coordinate disagreement.
		const resolver = createWOFResolver(await makeBackend([PC, SP_FAR, SP_NEAR]))

		const out = await resolver.resolveTree(tree([postcodeNode(), localityNode()]), {
			defaultCountry: { country: "FR", source: "caller" },
			postcodeConsistency: true,
			postcodeConsistencyMaxMoveKm: 1,
		})

		const loc = out.roots.find((n) => n.tag === "locality")!
		expect(loc.placeID).toBe("wof:2")
		expect(loc.metadata?.postcode_repicked).toBe(true)
	})

	it("leaves a locality already consistent with the postcode untouched", async () => {
		const resolver = createWOFResolver(await makeBackend([PC, SP_NEAR]))

		const out = await resolver.resolveTree(tree([postcodeNode(), localityNode()]), {
			defaultCountry: { country: "FR", source: "caller" },
			postcodeConsistency: true,
		})

		const loc = out.roots.find((n) => n.tag === "locality")!
		expect(loc.placeID).toBe("wof:2")
		expect(loc.metadata?.postcode_repicked).toBeUndefined()
		expect(loc.metadata?.postcode_city_mismatch).toBeUndefined()
	})

	it("DEFAULT (ON since the 2026-07-04 promote): unset opts re-pick the consistent instance", async () => {
		const resolver = createWOFResolver(await makeBackend([PC, SP_FAR, SP_NEAR]))

		const out = await resolver.resolveTree(tree([postcodeNode(), localityNode()]), {
			defaultCountry: { country: "FR", source: "caller" },
		})

		const loc = out.roots.find((n) => n.tag === "locality")!

		expect(loc.placeID).toBe("wof:2") // the postcode-consistent instance wins by default now
		expect(loc.metadata?.postcode_repicked).toBe(true)
	})

	it("is byte-stable when postcodeConsistency is EXPLICITLY false (keeps the wrong top match)", async () => {
		const resolver = createWOFResolver(await makeBackend([PC, SP_FAR, SP_NEAR]))

		const out = await resolver.resolveTree(tree([postcodeNode(), localityNode()]), {
			defaultCountry: { country: "FR", source: "caller" },
			postcodeConsistency: false,
		})

		const loc = out.roots.find((n) => n.tag === "locality")!

		expect(loc.placeID).toBe("wof:1")
		expect(loc.lat).toBeCloseTo(44)
	})

	it("no-ops when no postcode resolved (no anchor to disambiguate against)", async () => {
		const resolver = createWOFResolver(await makeBackend([SP_FAR, SP_NEAR]))

		const out = await resolver.resolveTree(tree([localityNode()]), {
			defaultCountry: { country: "FR", source: "caller" },
			postcodeConsistency: true,
		})

		const loc = out.roots.find((n) => n.tag === "locality")!
		expect(loc.placeID).toBe("wof:1")
	})
})
