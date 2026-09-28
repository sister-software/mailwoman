/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { AddressNode, AddressTree } from "@mailwoman/core/decoder"
import type { ResolvedPlace, ResolverBackend } from "@mailwoman/core/resolver"
import { createWOFResolver } from "@mailwoman/resolver/resolve"
import { postcodeCodeSubset } from "@mailwoman/resolver/span-rescore"
import { describe, expect, it } from "vitest"

import { backendNameKey } from "../helpers/backend-name-key.ts"

const norm = backendNameKey

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
	{
		id: 2,
		name: "Kožljek",
		placetype: "locality",
		country: "HR",
		lat: 42,
		lon: 18,
		score: 10,
		exactMatch: true,
	},
]

async function makeBackend(places: ResolvedPlace[] = PLACES): Promise<ResolverBackend> {
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
	it("extracts digit-containing tokens", () => {
		expect(postcodeCodeSubset("1382 Kožljek")).toBe("1382")
		expect(postcodeCodeSubset("SW1A 1AA London")).toBe("SW1A 1AA")
		expect(postcodeCodeSubset("Kožljek")).toBe("")
	})
})

describe("postal-compound recovery (#942)", () => {
	it("flag OFF (explicit): the tree stays unresolved — the pre-#942 behavior", async () => {
		const resolver = createWOFResolver(await makeBackend())
		const out = await resolver.resolveTree(failingTree(), { defaultCountry: "SI", postalCompoundRecovery: false })
		const resolved = out.roots.filter((n) => n.placeID)

		expect(resolved).toHaveLength(0)
	})

	it("DEFAULT (flag ON since the 2026-07-03 promote): the compound recovers without opting in", async () => {
		const resolver = createWOFResolver(await makeBackend())
		const out = await resolver.resolveTree(failingTree(), { defaultCountry: "SI" })
		const locality = out.roots.find((n) => n.tag === "locality" && n.placeID)

		expect(locality).toBeDefined()
		expect(locality!.lat).toBeCloseTo(45.8, 1)
	})

	it("flag ON: recovers the trailing city from the globbed postcode span, check-validated", async () => {
		const resolver = createWOFResolver(await makeBackend())
		const out = await resolver.resolveTree(failingTree(), { defaultCountry: "SI", postalCompoundRecovery: true })
		const locality = out.roots.find((n) => n.tag === "locality" && n.placeID)

		expect(locality).toBeDefined()
		expect(locality!.lat).toBeCloseTo(45.8, 1)
		expect(locality!.metadata?.span_rescore).toBe(true)
		expect(locality!.metadata?.rescore_postcode_verified).toBe(true)
		// The postcode node stays undecorated when a locality was recovered: its medoid centroid is
		// coarser than the village pin, and postcode-over-locality consumers must not trade down.
		const pc = out.roots.find((n) => n.tag === "postcode")

		expect(pc?.placeID).toBeFalsy()
	})

	it("flag ON: the postcode node gains the code-subset coordinate floor ONLY when no city matches", async () => {
		const resolver = createWOFResolver(await makeBackend())
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
		const resolver = createWOFResolver(await makeBackend())

		const tree: AddressTree = {
			raw: "Kožljek, Slovenia",
			roots: [node({ tag: "locality", value: "Kožljek", start: 0, end: 7 })],
		}

		const out = await resolver.resolveTree(tree, { defaultCountry: "SI", postalCompoundRecovery: true })
		const pc = out.roots.find((n) => n.tag === "postcode")

		expect(pc).toBeUndefined()
		expect(out.roots.filter((n) => n.placeID)).toHaveLength(1)
	})

	it("flag ON: street tokens stay blocked — no 'Ave, France' resurrection", async () => {
		const resolver = createWOFResolver(await makeBackend())

		const tree: AddressTree = {
			raw: "Kožljek 7",
			roots: [
				node({ tag: "street", value: "Kožljek", start: 0, end: 7 }),
				node({ tag: "house_number", value: "7", start: 8, end: 9 }),
			],
		}

		const out = await resolver.resolveTree(tree, { defaultCountry: "SI", postalCompoundRecovery: true })

		expect(out.roots.filter((n) => n.placeID)).toHaveLength(0)
	})

	it("check rejects a cross-border same-named decoy (unscoped)", async () => {
		const resolver = createWOFResolver(await makeBackend())
		const out = await resolver.resolveTree(failingTree(), { postalCompoundRecovery: true })
		const locality = out.roots.find((n) => n.tag === "locality" && n.placeID)

		expect(locality).toBeDefined()
		expect(locality!.lat).toBeCloseTo(45.8, 1)
	})
})

describe("#961 joint country recovery — the locale-default trap", () => {
	// The joint pass probes spans unscoped and verifies each candidate against the postcode resolved in
	// the candidate's own country — cross-country promotion only postcode-verified, never unrestricted.
	it("recovers under a WRONG defaultCountry via the postcode-verified joint pass", async () => {
		const resolver = createWOFResolver(await makeBackend())
		const out = await resolver.resolveTree(failingTree(), { defaultCountry: "US" })
		const locality = out.roots.find((n) => n.tag === "locality" && n.placeID)

		expect(locality).toBeDefined()
		expect(locality!.lat).toBeCloseTo(45.8, 1)
		expect(locality!.metadata?.rescore_postcode_verified).toBe(true)
	})

	it("rejects a cross-country namesake whose own country cannot verify the postcode", async () => {
		const resolver = createWOFResolver(
			await makeBackend(PLACES.filter((p) => !(p.placetype === "locality" && p.country === "SI")))
		)

		const out = await resolver.resolveTree(failingTree(), { defaultCountry: "US" })

		expect(out.roots.filter((n) => n.tag === "locality" && n.placeID)).toHaveLength(0)
	})

	it("never cross-promotes without a postcode present (no unrestricted wandering)", async () => {
		const resolver = createWOFResolver(await makeBackend())

		const tree: AddressTree = {
			raw: "Kožljek 7",
			roots: [
				node({ tag: "street", value: "Kožljek", start: 0, end: 7 }),
				node({ tag: "house_number", value: "7", start: 8, end: 9 }),
			],
		}

		const out = await resolver.resolveTree(tree, { defaultCountry: "US" })

		expect(out.roots.filter((n) => n.placeID)).toHaveLength(0)
	})
})
