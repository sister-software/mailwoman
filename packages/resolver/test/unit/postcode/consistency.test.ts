/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for #370 "Change A" — postcode-disambiguated locality selection
 *   (`opts.postcodeConsistency`). A same-named locality that resolves far from a resolved sibling
 *   postcode is either re-picked from its alternatives (the same-named instance nearest the
 *   postcode) or, if none reconciles, has its coordinate fall back to the postcode point + flagged.
 *   Byte-stable when the flag is unset.
 */

import type { AddressNode, AddressTree } from "@mailwoman/core/decoder"
import type { ResolvedPlace, ResolverBackend } from "@mailwoman/core/resolver"
import { createWOFResolver, DEFAULT_POSTCODE_MAX_MOVE_KM } from "@mailwoman/resolver/resolve"
import { describe, expect, it } from "vitest"

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
	lat: 44,
	lon: 5,
	score: 8,
	exactMatch: true,
}

// ~600 km from PC
const SP_NEAR = {
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
 * A backend that returns the given places in order, filtered by name-substring + placetype + country.
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
		// Backend returns the FAR Saint-Pierre first → top is wrong. the near one is an alternative.
		const resolver = createWOFResolver(await makeBackend([PC, SP_FAR, SP_NEAR]))

		const out = await resolver.resolveTree(tree([postcodeNode(), localityNode()]), {
			defaultCountry: "FR",
			postcodeConsistency: true,
		})

		const loc = out.roots.find((n) => n.tag === "locality")!
		expect(loc.placeID).toBe("wof:2") // re-picked to the postcode-consistent instance
		expect(loc.lat).toBeCloseTo(48.9)
		expect(loc.metadata?.postcode_repicked).toBe(true)
	})

	it("falls the coordinate back to the postcode when no same-named instance reconciles", async () => {
		// Only the FAR Saint-Pierre exists — no alternative within the radius → demote to the postcode point.
		// SP_FAR sits ~577 km from PC, past the 300 km default, so the unbounded configuration is named here. the
		// default's refusal on this same pair is the next case but one.
		const resolver = createWOFResolver(await makeBackend([PC, SP_FAR]))

		const out = await resolver.resolveTree(tree([postcodeNode(), localityNode()]), {
			defaultCountry: "FR",
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
		// SP_FAR sits ~577 km from PC, so the unbounded pass relocates it onto the postcode. Under a 200 km cap the
		// postcode is the likelier error and the answer stays on the locality the walk selected — still flagged,
		// because the two components did disagree.
		const resolver = createWOFResolver(await makeBackend([PC, SP_FAR]))

		const out = await resolver.resolveTree(tree([postcodeNode(), localityNode()]), {
			defaultCountry: "FR",
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
		// The default changed from unbounded on 2026-09-15. Measured on 5,300 real addresses the pass's wins are all
		// step-2 re-picks, so no arm from a cap of zero upward differs from unbounded by a row
		// (docs/records/evals/2026-09-15-postcode-move-cap.md).
		const resolver = createWOFResolver(await makeBackend([PC, SP_FAR]))

		const out = await resolver.resolveTree(tree([postcodeNode(), localityNode()]), {
			defaultCountry: "FR",
			postcodeConsistency: true,
		})

		const loc = out.roots.find((n) => n.tag === "locality")!

		expect(loc.placeID).toBe("wof:1")
		expect(loc.metadata?.postcode_city_mismatch).toBe(true)
		expect(loc.metadata?.coordinate_source).toBeUndefined()
		expect(loc.metadata?.postcode_move_refused_km).toBeGreaterThan(DEFAULT_POSTCODE_MAX_MOVE_KM)
	})

	it("admits the fallback when the move is inside the cap", async () => {
		// The same pair under a cap wider than the gap behaves exactly as the uncapped pass does.
		const resolver = createWOFResolver(await makeBackend([PC, SP_FAR]))

		const out = await resolver.resolveTree(tree([postcodeNode(), localityNode()]), {
			defaultCountry: "FR",
			postcodeConsistency: true,
			postcodeConsistencyMaxMoveKm: 1000,
		})

		const loc = out.roots.find((n) => n.tag === "locality")!
		expect(loc.lat).toBeCloseTo(48.86)
		expect(loc.metadata?.coordinate_source).toBe("postcode_fallback")
		expect(loc.metadata?.postcode_move_refused_km).toBeUndefined()
	})

	it("a cap never blocks the re-pick, which moves to a same-named instance rather than the postcode", async () => {
		// Step 2 chooses among the locality's own alternatives. Therefore, it cannot produce an id/coordinate disagreement
		// and the cap has no business refusing it.
		const resolver = createWOFResolver(await makeBackend([PC, SP_FAR, SP_NEAR]))

		const out = await resolver.resolveTree(tree([postcodeNode(), localityNode()]), {
			defaultCountry: "FR",
			postcodeConsistency: true,
			postcodeConsistencyMaxMoveKm: 1,
		})

		const loc = out.roots.find((n) => n.tag === "locality")!
		expect(loc.placeID).toBe("wof:2")
		expect(loc.metadata?.postcode_repicked).toBe(true)
	})

	it("leaves a locality already consistent with the postcode untouched", async () => {
		// near is the only/top candidate and it's within the radius → no change.
		const resolver = createWOFResolver(await makeBackend([PC, SP_NEAR]))

		const out = await resolver.resolveTree(tree([postcodeNode(), localityNode()]), {
			defaultCountry: "FR",
			postcodeConsistency: true,
		})

		const loc = out.roots.find((n) => n.tag === "locality")!
		expect(loc.placeID).toBe("wof:2")
		expect(loc.metadata?.postcode_repicked).toBeUndefined()
		expect(loc.metadata?.postcode_city_mismatch).toBeUndefined()
	})

	it("DEFAULT (ON since the 2026-07-04 promote): unset opts re-pick the consistent instance", async () => {
		const resolver = createWOFResolver(await makeBackend([PC, SP_FAR, SP_NEAR]))
		const out = await resolver.resolveTree(tree([postcodeNode(), localityNode()]), { defaultCountry: "FR" })
		const loc = out.roots.find((n) => n.tag === "locality")!

		expect(loc.placeID).toBe("wof:2") // the postcode-consistent instance wins by default now
		expect(loc.metadata?.postcode_repicked).toBe(true)
	})

	it("is byte-stable when postcodeConsistency is EXPLICITLY false (keeps the wrong top match)", async () => {
		const resolver = createWOFResolver(await makeBackend([PC, SP_FAR, SP_NEAR]))

		const out = await resolver.resolveTree(tree([postcodeNode(), localityNode()]), {
			defaultCountry: "FR",
			postcodeConsistency: false,
		})

		const loc = out.roots.find((n) => n.tag === "locality")!

		expect(loc.placeID).toBe("wof:1") // the far one — untouched without the change
		expect(loc.lat).toBeCloseTo(44)
	})

	it("no-ops when no postcode resolved (no anchor to disambiguate against)", async () => {
		// No postcode in the tree → Change A can't fire. the (wrong) top match stands.
		const resolver = createWOFResolver(await makeBackend([SP_FAR, SP_NEAR]))
		const out = await resolver.resolveTree(tree([localityNode()]), { defaultCountry: "FR", postcodeConsistency: true })
		const loc = out.roots.find((n) => n.tag === "locality")!
		expect(loc.placeID).toBe("wof:1")
	})
})
