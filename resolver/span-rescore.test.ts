/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for the #370 span-rescore: the pure `findRescoreCandidate` (raw-token enumeration, longest-
 *   wins, postcode gate) and its `resolveTree` integration (opt-in injection, the #685 brake, byte-
 *   stability when the flag is unset). A fixture backend stands in for the gazetteer.
 */

import { describe, expect, it } from "vitest"

import type { AddressNode, AddressTree } from "@mailwoman/core/decoder"
import type { ResolvedPlace, ResolverBackend } from "@mailwoman/core/resolver"
import { createWofResolver } from "./resolve.js"
import { findRescoreCandidate, hasResolvedPlace } from "./span-rescore.js"

const norm = (s: string): string =>
	s
		.toLowerCase()
		.normalize("NFD")
		.replace(/[^a-z0-9 ]/g, " ")
		.replace(/\s+/g, " ")
		.trim()

/** A tiny gazetteer: exact-normalized-name matches only (so the walk can't fuzzy-resolve fragments). */
const PLACES: ResolvedPlace[] = [
	{
		id: 1,
		name: "Grudziądz",
		placetype: "locality",
		country: "PL",
		lat: 53.48,
		lon: 18.75,
		score: 10,
		exactMatch: true,
	},
	// Two same-prefix localities far apart — the longest-wins + gate test.
	{
		id: 2,
		name: "Tomaszów",
		placetype: "locality",
		country: "PL",
		lat: 50.45,
		lon: 23.42,
		score: 30,
		exactMatch: true,
	},
	{
		id: 3,
		name: "Tomaszów Mazowiecki",
		placetype: "locality",
		country: "PL",
		lat: 51.53,
		lon: 20.0,
		score: 5,
		exactMatch: true,
	},
	// A postcode → point, near Tomaszów Mazowiecki (the gate anchor).
	{ id: 900, name: "97-200", placetype: "postalcode", country: "PL", lat: 51.53, lon: 20.01, score: 1 },
]

function makeBackend(): ResolverBackend {
	return {
		async findPlace(query) {
			const key = norm(query.text)
			return PLACES.filter((p) => norm(p.name) === key && (!query.country || p.country === query.country)).map((p) => ({
				...p,
			}))
		},
	}
}

const node = (over: Partial<AddressNode> & Pick<AddressNode, "tag" | "value" | "start" | "end">): AddressNode => ({
	confidence: 0.95,
	children: [],
	...over,
})

describe("findRescoreCandidate", () => {
	it("recovers a fragmented locality from the raw text", async () => {
		// The model split "Grudziądz" into "Grudzi" + "dz"; neither resolves. The raw word is intact.
		const raw = "86-300 Grudziądz, Daliowa 4"
		const roots: AddressNode[] = [
			node({ tag: "postcode", value: "86-300", start: 0, end: 6 }),
			node({ tag: "locality", value: "Grudzi", start: 7, end: 13 }),
			node({ tag: "locality", value: "dz", start: 14, end: 16, confidence: 0.9 }),
		]
		const hit = await findRescoreCandidate(raw, roots, makeBackend(), { country: "PL", postcode: "86-300" })
		expect(hit?.text).toBe("Grudziądz")
		expect(hit?.place.id).toBe(1)
		// 86-300 isn't in the fixture → no anchor → ungated (flagged lower-precision).
		expect(hit?.gated).toBe(false)
	})

	it("prefers the LONGEST exact match (specific name beats its own prefix)", async () => {
		const raw = "Tomaszów Mazowiecki" // gold is the longer name; shortest-wins would grab "Tomaszów"
		const hit = await findRescoreCandidate(raw, [], makeBackend(), { country: "PL", gateKm: 0 })
		expect(hit?.text).toBe("Tomaszów Mazowiecki")
		expect(hit?.place.id).toBe(3)
		expect(hit?.gated).toBe(false) // gate disabled (gateKm 0)
	})

	it("flags a recovery GATED when the postcode resolves and the match is within range", async () => {
		// 97-200 resolves (fixture) near Tomaszów Mazowiecki; the longest match lands within 50km → gated.
		const hit = await findRescoreCandidate("Tomaszów Mazowiecki", [], makeBackend(), {
			country: "PL",
			postcode: "97-200",
			gateKm: 50,
		})
		expect(hit?.place.id).toBe(3)
		expect(hit?.gated).toBe(true)
	})

	it("postcode gate rejects a match far from where the postcode resolves", async () => {
		// "Tomaszów" alone exact-matches the FAR Tomaszów (id 2); the 97-200 postcode anchors near the
		// Mazowiecki one (~240 km away), so the gate rejects it → no recovery.
		const hit = await findRescoreCandidate("Tomaszów", [], makeBackend(), {
			country: "PL",
			postcode: "97-200",
			gateKm: 50,
		})
		expect(hit).toBeNull()
	})

	it("skips a span overlapping a confident street/house_number/postcode constituent", async () => {
		// "Grudziądz" sits where a confident postcode node is declared → not eligible as a locality span.
		const raw = "Grudziądz 4"
		const roots: AddressNode[] = [node({ tag: "postcode", value: "Grudziądz", start: 0, end: 9, confidence: 0.95 })]
		const hit = await findRescoreCandidate(raw, roots, makeBackend(), { country: "PL", gateKm: 0 })
		expect(hit).toBeNull()
	})
})

describe("hasResolvedPlace", () => {
	it("detects a resolved node anywhere in the tree", () => {
		expect(hasResolvedPlace([node({ tag: "locality", value: "x", start: 0, end: 1 })])).toBe(false)
		const resolved = node({ tag: "locality", value: "x", start: 0, end: 1 })
		resolved.placeId = "wof:1"
		expect(hasResolvedPlace([resolved])).toBe(true)
	})
})

describe("resolveTree + spanRescore", () => {
	const tree = (raw: string, roots: AddressNode[]): AddressTree => ({ raw, roots })

	it("injects a resolved locality when the tree resolved nothing (opt-in)", async () => {
		const resolver = createWofResolver(makeBackend())
		const input = tree("86-300 Grudziądz, Daliowa 4", [
			node({ tag: "locality", value: "Grudzi", start: 7, end: 13 }),
			node({ tag: "locality", value: "dz", start: 14, end: 16 }),
		])
		const out = await resolver.resolveTree(input, { defaultCountry: "PL", spanRescore: true })
		const injected = out.roots.find((n) => n.placeId === "wof:1")
		expect(injected).toBeDefined()
		expect(injected?.tag).toBe("locality")
		expect(injected?.value).toBe("Grudziądz")
		expect(injected?.lat).toBe(53.48)
		expect(injected?.metadata?.span_rescore).toBe(true)
		// No postcode node in this tree → no anchor → ungated, flagged so the consumer can threshold.
		expect(injected?.metadata?.rescore_gated).toBe(false)
	})

	it("injects by default when spanRescore is unset (#370 promoted to default-on 2026-06-25)", async () => {
		const resolver = createWofResolver(makeBackend())
		const input = tree("86-300 Grudziądz, Daliowa 4", [
			node({ tag: "locality", value: "Grudzi", start: 7, end: 13 }),
			node({ tag: "locality", value: "dz", start: 14, end: 16 }),
		])
		// No `spanRescore` in opts — the default (ON) must still recover the locality.
		const out = await resolver.resolveTree(input, { defaultCountry: "PL" })
		expect(out.roots.find((n) => n.placeId === "wof:1")?.value).toBe("Grudziądz")
	})

	it("is byte-stable when spanRescore is false (explicit opt-out — the #685/byte-stable contract)", async () => {
		const resolver = createWofResolver(makeBackend())
		const roots = [node({ tag: "locality", value: "Grudzi", start: 7, end: 13 })]
		const out = await resolver.resolveTree(tree("86-300 Grudziądz", roots), {
			defaultCountry: "PL",
			spanRescore: false,
		})
		expect(out.roots.some((n) => n.placeId)).toBe(false)
		expect(out.roots).toHaveLength(1)
	})

	it("does not fire when the tree already resolved (the #685 brake)", async () => {
		const resolver = createWofResolver(makeBackend())
		// "Grudziądz" as a single locality node resolves in the walk → already has a coordinate.
		const out = await resolver.resolveTree(
			tree("Grudziądz", [node({ tag: "locality", value: "Grudziądz", start: 0, end: 9 })]),
			{
				defaultCountry: "PL",
				spanRescore: true,
			}
		)
		// Exactly one locality node (the resolved original), no injected duplicate.
		expect(out.roots.filter((n) => n.tag === "locality")).toHaveLength(1)
	})
})
