/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for #263 admin descendant-consistency (`opts.adminCoherence`). When a region resolves to a
 *   foreign namesake (greedy by population — "ME" → Messina, IT) and its child locality then finds
 *   nothing beneath it, re-pick the (region, locality) pair so the locality descends from a same-named
 *   region candidate ("Portland" → Maine, not Messina). Joint over the containment graph; no country
 *   prior, no list. Byte-stable when the flag is unset and when no consistent pair exists.
 */

import type { AddressNode, AddressTree } from "@mailwoman/core/decoder"
import type { ResolvedPlace, ResolverBackend } from "@mailwoman/core/resolver"
import { describe, expect, it } from "vitest"

import { createWOFResolver } from "./resolve.js"

// "ME" → Messina (IT, greedy top by population) and Maine (US) — both exact abbrev matches.
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
// A loose fuzzy runner-up ("ME" surfaces M-states) — must be ignored (not an exact match).
const MISSOURI = {
	id: 30,
	name: "Missouri",
	placetype: "region",
	country: "US",
	lat: 38.4,
	lon: -92.5,
	score: 6,
	exactMatch: false,
}
// Portland lives under Maine (parent_id 20), not under Messina.
const PORTLAND_ME: ResolvedPlace = {
	id: 21,
	name: "Portland",
	placetype: "locality",
	country: "US",
	parent_id: 20,
	lat: 43.66,
	lon: -70.25,
	score: 8,
	exactMatch: true,
}

/** Backend filtered by name-substring + placetype + country + `parentID` (descendant scope via parent_id). */
function makeBackend(places: ResolvedPlace[]): ResolverBackend {
	return {
		async findPlace(query) {
			const text = query.text.toLowerCase()
			const types = Array.isArray(query.placetype) ? query.placetype : query.placetype ? [query.placetype] : null

			return places
				.filter((p) => p.name.toLowerCase() === text || (p.placetype === "region" && text.length === 2)) // 2-letter abbrev matches its region candidates
				.filter((p) => !types || types.includes(p.placetype))
				.filter((p) => !query.country || p.country === query.country)
				.filter((p) => query.parentID === undefined || p.parent_id === query.parentID)
				.slice(0, query.limit ?? 5)
		},
	}
}

const node = (over: Partial<AddressNode> & Pick<AddressNode, "tag" | "value" | "start" | "end">): AddressNode => ({
	confidence: 0.95,
	children: [],
	...over,
})
// region(ME) → locality(Portland), the shape recognizeUSRegions produces for "Portland, ME".
const portlandMeTree = (): AddressTree => ({
	raw: "Portland, ME",
	roots: [
		node({
			tag: "region",
			value: "ME",
			start: 9,
			end: 11,
			children: [node({ tag: "locality", value: "Portland", start: 0, end: 8 })],
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

describe("resolveTree + adminCoherence (#263)", () => {
	it("re-picks (region, locality) so the locality descends from the region", async () => {
		const resolver = createWOFResolver(makeBackend([MESSINA, MAINE, MISSOURI, PORTLAND_ME]))
		const out = await resolver.resolveTree(portlandMeTree(), { adminCoherence: true })
		const loc = localityOf(out)

		expect(loc?.lat).toBeCloseTo(43.66, 2)
		expect(loc?.lon).toBeCloseTo(-70.25, 2)
		expect(loc?.metadata?.["admin_coherence_repicked"]).toBe(true)
	})

	it("is byte-stable when adminCoherence is unset (locality stays unresolved under the greedy region)", async () => {
		const resolver = createWOFResolver(makeBackend([MESSINA, MAINE, MISSOURI, PORTLAND_ME]))
		const out = await resolver.resolveTree(portlandMeTree(), {})
		const loc = localityOf(out)

		// Greedy walk scoped Portland to Messina (parent 10) → nothing → unresolved; no re-pick.
		expect(loc?.lat == null || (loc.lat === 0 && loc.lon === 0)).toBe(true)
		expect(loc?.metadata?.["admin_coherence_repicked"]).toBeUndefined()
	})

	it("does not re-pick when no same-named locality descends from any region candidate", async () => {
		// No Portland anywhere → the pass finds no consistent pair and leaves the tree alone.
		const resolver = createWOFResolver(makeBackend([MESSINA, MAINE, MISSOURI]))
		const out = await resolver.resolveTree(portlandMeTree(), { adminCoherence: true })
		const loc = localityOf(out)

		expect(loc?.metadata?.["admin_coherence_repicked"]).toBeUndefined()
	})

	it("ignores fuzzy (non-exact) region candidates — a Portland under Missouri must NOT match the token 'ME'", async () => {
		// Place a Portland under Missouri (the fuzzy runner-up). Since MISSOURI.exactMatch is false, the
		// pass must not consider it, so no re-pick to Missouri.
		const PORTLAND_MO: ResolvedPlace = { ...PORTLAND_ME, id: 31, parent_id: 30, lat: 37.0, lon: -93.0 }
		const resolver = createWOFResolver(makeBackend([MESSINA, MISSOURI, PORTLAND_MO]))
		const out = await resolver.resolveTree(portlandMeTree(), { adminCoherence: true })
		const loc = localityOf(out)

		expect(loc?.metadata?.["admin_coherence_repicked"]).toBeUndefined()
	})

	it("falls through to a same-named COUNTRY when no region holds the locality (#267 — Tbilisi, Georgia)", async () => {
		// "Georgia" the US state vs Georgia the country. Tbilisi descends from the COUNTRY, Atlanta from the state.
		const usGeorgia = {
			id: 40,
			name: "Georgia",
			placetype: "region",
			country: "US",
			lat: 32.6,
			lon: -83.4,
			score: 9,
			exactMatch: true,
		}
		const georgiaCountry = {
			id: 50,
			name: "Georgia",
			placetype: "country",
			country: "GE",
			lat: 42.0,
			lon: 43.5,
			score: 8,
			exactMatch: true,
		}
		const tbilisi: ResolvedPlace = {
			id: 51,
			name: "Tbilisi",
			placetype: "locality",
			country: "GE",
			parent_id: 50,
			lat: 41.69,
			lon: 44.83,
			score: 7,
			exactMatch: true,
		}
		const atlanta: ResolvedPlace = {
			id: 41,
			name: "Atlanta",
			placetype: "locality",
			country: "US",
			parent_id: 40,
			lat: 33.76,
			lon: -84.42,
			score: 9,
			exactMatch: true,
		}
		const tree = (city: string): AddressTree => ({
			raw: `${city}, Georgia`,
			roots: [
				node({
					tag: "region",
					value: "Georgia",
					start: city.length + 2,
					end: city.length + 9,
					children: [node({ tag: "locality", value: city, start: 0, end: city.length })],
				}),
			],
		})
		const resolver = createWOFResolver(makeBackend([usGeorgia, georgiaCountry, tbilisi, atlanta]))

		// Tbilisi has no descendant under the US state → fall through to Georgia the country.
		const tb = localityOf(await resolver.resolveTree(tree("Tbilisi"), { adminCoherence: true }))
		expect(tb?.lat).toBeCloseTo(41.69, 2)
		expect(tb?.metadata?.["admin_coherence_repicked"]).toBe(true)

		// Atlanta IS under the US state → it resolves in the walk; no country fall-through.
		const at = localityOf(await resolver.resolveTree(tree("Atlanta"), { adminCoherence: true }))
		expect(at?.lat).toBeCloseTo(33.76, 2)
	})
})
