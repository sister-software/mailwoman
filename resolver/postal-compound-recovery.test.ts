/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for the #942 postal-compound recovery — the knife-edge no-street query shape
 *   ("Kožljek 7, 1382 Kožljek") whose parse globs the trailing city into the postcode span. The
 *   fixture mirrors the real failure: the compound resolves as nothing, the confident postcode
 *   span blocks its own city tokens, and the tree comes back empty. With the flag on, the code
 *   subset anchors the gate, the residual city tokens become span material, and the failed
 *   postcode node gains a coordinate floor. Street blocking (the "Ave, France" guard) stays.
 */

import type { AddressNode, AddressTree } from "@mailwoman/core/decoder"
import type { ResolvedPlace, ResolverBackend } from "@mailwoman/core/resolver"
import { describe, expect, it } from "vitest"

import { createWOFResolver } from "./resolve.ts"
import { postcodeCodeSubset } from "./span-rescore.ts"

const norm = (s: string): string =>
	s
		.toLowerCase()
		.normalize("NFD")
		.replace(/[^a-z0-9 ]/g, " ")
		.replace(/\s+/g, " ")
		.trim()

/** The SI shape: the village + its bare-code postcode row (the #920 name law — codes stored bare). */
const PLACES: ResolvedPlace[] = [
	{
		id: 1,
		name: "Kožljek",
		placetype: "locality",
		country: "SI",
		lat: 45.8,
		lon: 14.4,
		score: 10,
		exactMatch: true,
	},
	{ id: 900, name: "1382", placetype: "postalcode", country: "SI", lat: 45.82, lon: 14.42, score: 1 },
	// A distant same-named decoy in another country — the gate + country constraint must hold.
	{
		id: 2,
		name: "Kožljek",
		placetype: "locality",
		country: "HR",
		lat: 42.0,
		lon: 18.0,
		score: 10,
		exactMatch: true,
	},
]

function makeBackend(places: ResolvedPlace[] = PLACES): ResolverBackend {
	return {
		async findPlace(query) {
			const key = norm(query.text)

			return places
				.filter(
					(p) =>
						norm(p.name) === key &&
						(!query.country || p.country === query.country) &&
						(!query.placetype || query.placetype.includes(p.placetype))
				)
				.map((p) => ({ ...p }))
		},
	}
}

const node = (over: Partial<AddressNode> & Pick<AddressNode, "tag" | "value" | "start" | "end">): AddressNode => ({
	confidence: 0.95,
	children: [],
	...over,
})

/** The real failure shape: "Kožljek 7, 1382 Kožljek" — street+hn lead, globbed postcode trail. */
function failingTree(): AddressTree {
	const raw = "Kožljek 7, 1382 Kožljek"

	return {
		raw,
		roots: [
			node({ tag: "street", value: "Kožljek", start: 0, end: 7 }),
			node({ tag: "house_number", value: "7", start: 8, end: 9 }),
			node({ tag: "postcode", value: "1382 Kožljek", start: 11, end: 23 }),
		],
	}
}

describe("postcodeCodeSubset", () => {
	it("extracts digit-bearing tokens", () => {
		expect(postcodeCodeSubset("1382 Kožljek")).toBe("1382")
		expect(postcodeCodeSubset("SW1A 1AA London")).toBe("SW1A 1AA")
		expect(postcodeCodeSubset("Kožljek")).toBe("")
	})
})

describe("postal-compound recovery (#942)", () => {
	it("flag OFF (explicit): the tree stays unresolved — the pre-#942 behavior", async () => {
		const resolver = createWOFResolver(makeBackend())
		const out = await resolver.resolveTree(failingTree(), { defaultCountry: "SI", postalCompoundRecovery: false })
		const resolved = out.roots.filter((n) => n.placeID)

		expect(resolved.length).toBe(0)
	})

	it("DEFAULT (flag ON since the 2026-07-03 promote): the compound recovers without opting in", async () => {
		const resolver = createWOFResolver(makeBackend())
		const out = await resolver.resolveTree(failingTree(), { defaultCountry: "SI" })
		const locality = out.roots.find((n) => n.tag === "locality" && n.placeID)

		expect(locality).toBeDefined()
		expect(locality!.lat).toBeCloseTo(45.8, 1)
	})

	it("flag ON: recovers the trailing city from the globbed postcode span, gate-validated", async () => {
		const resolver = createWOFResolver(makeBackend())
		const out = await resolver.resolveTree(failingTree(), { defaultCountry: "SI", postalCompoundRecovery: true })
		const locality = out.roots.find((n) => n.tag === "locality" && n.placeID)

		expect(locality).toBeDefined()
		expect(locality!.lat).toBeCloseTo(45.8, 1)
		expect(locality!.metadata?.span_rescore).toBe(true)
		expect(locality!.metadata?.rescore_gated).toBe(true) // the code-subset anchor validated it
		// The postcode node stays UNdecorated when a locality was recovered — its medoid centroid is
		// coarser than the village pin, and postcode-over-locality consumers must not trade down.
		const pc = out.roots.find((n) => n.tag === "postcode")

		expect(pc?.placeID).toBeFalsy()
	})

	it("flag ON: the postcode node gains the code-subset coordinate floor ONLY when no city matches", async () => {
		const resolver = createWOFResolver(makeBackend())
		// "Neznano" is not in the gazetteer — the locality rescue misses, so the floor fires.
		const raw = "Neznano 7, 1382 Neznano"
		const tree: AddressTree = {
			raw,
			roots: [
				node({ tag: "street", value: "Neznano", start: 0, end: 7 }),
				node({ tag: "house_number", value: "7", start: 8, end: 9 }),
				node({ tag: "postcode", value: "1382 Neznano", start: 11, end: 23 }),
			],
		}
		const out = await resolver.resolveTree(tree, { defaultCountry: "SI", postalCompoundRecovery: true })
		const pc = out.roots.find((n) => n.tag === "postcode")

		expect(pc?.placeID).toBeTruthy()
		expect(pc?.lat).toBeCloseTo(45.82, 2)
		expect(pc?.metadata?.postal_compound_recovered).toBe(true)
	})

	it("flag ON: never disturbs a resolved tree (the #685 brake)", async () => {
		const resolver = createWOFResolver(makeBackend())
		const tree: AddressTree = {
			raw: "Kožljek, Slovenia",
			roots: [node({ tag: "locality", value: "Kožljek", start: 0, end: 7 })],
		}
		const out = await resolver.resolveTree(tree, { defaultCountry: "SI", postalCompoundRecovery: true })
		const pc = out.roots.find((n) => n.tag === "postcode")

		expect(pc).toBeUndefined() // nothing synthesized
		expect(out.roots.filter((n) => n.placeID).length).toBe(1)
	})

	it("flag ON: street tokens stay blocked — no 'Ave, France' resurrection", async () => {
		// A street-only failing parse: the street token equals a real place name, but street blocking
		// must keep it out of recovery even with the flag on.
		const resolver = createWOFResolver(makeBackend())
		const tree: AddressTree = {
			raw: "Kožljek 7",
			roots: [
				node({ tag: "street", value: "Kožljek", start: 0, end: 7 }),
				node({ tag: "house_number", value: "7", start: 8, end: 9 }),
			],
		}
		const out = await resolver.resolveTree(tree, { defaultCountry: "SI", postalCompoundRecovery: true })

		expect(out.roots.filter((n) => n.placeID).length).toBe(0)
	})

	it("gate rejects a cross-border same-named decoy (unscoped)", async () => {
		// No defaultCountry: the HR decoy is name-identical. The code-subset anchor (SI 1382) plus the
		// 50km gate must reject the 400+km decoy and accept the SI village.
		const resolver = createWOFResolver(makeBackend())
		const out = await resolver.resolveTree(failingTree(), { postalCompoundRecovery: true })
		const locality = out.roots.find((n) => n.tag === "locality" && n.placeID)

		// Both candidates surface; the gate keeps only the SI one.
		expect(locality).toBeDefined()
		expect(locality!.lat).toBeCloseTo(45.8, 1)
	})
})

describe("#961 joint country recovery — the locale-default trap", () => {
	// The CLI's en-US locale default scoped both the anchor and the village probe to US, so the SI
	// floor never fired through geocode-core. The joint pass probes spans unscoped and verifies each
	// candidate against the postcode resolved in the CANDIDATE's own country — cross-country
	// promotion only postcode-verified, never ungated.
	it("recovers under a WRONG defaultCountry via the postcode-verified joint pass", async () => {
		const resolver = createWOFResolver(makeBackend())
		const out = await resolver.resolveTree(failingTree(), { defaultCountry: "US" })
		const locality = out.roots.find((n) => n.tag === "locality" && n.placeID)

		expect(locality).toBeDefined()
		expect(locality!.lat).toBeCloseTo(45.8, 1)
		expect(locality!.metadata?.rescore_gated).toBe(true)
	})

	it("rejects a cross-country namesake whose own country cannot verify the postcode", async () => {
		// The HR decoy shares the name but HR holds no postcode "1382" → the joint pass must not
		// promote it; with the SI row removed the tree stays unresolved rather than guessing.
		const resolver = createWOFResolver(
			makeBackend(PLACES.filter((p) => !(p.placetype === "locality" && p.country === "SI")))
		)
		const out = await resolver.resolveTree(failingTree(), { defaultCountry: "US" })

		expect(out.roots.filter((n) => n.tag === "locality" && n.placeID).length).toBe(0)
	})

	it("never cross-promotes without a postcode present (no ungated wandering)", async () => {
		const resolver = createWOFResolver(makeBackend())
		const tree: AddressTree = {
			raw: "Kožljek 7",
			roots: [
				node({ tag: "street", value: "Kožljek", start: 0, end: 7 }),
				node({ tag: "house_number", value: "7", start: 8, end: 9 }),
			],
		}
		const out = await resolver.resolveTree(tree, { defaultCountry: "US" })

		expect(out.roots.filter((n) => n.placeID).length).toBe(0)
	})
})
