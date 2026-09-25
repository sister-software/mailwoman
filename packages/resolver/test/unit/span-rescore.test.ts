import type { AddressNode, AddressTree } from "@mailwoman/core/decoder"
import type { ResolvedPlace, ResolverBackend } from "@mailwoman/core/resolver"
import { createWOFResolver } from "@mailwoman/resolver/resolve"
import { findRescoreCandidate, hasResolvedPlace } from "@mailwoman/resolver/span-rescore"
import { describe, expect, it } from "vitest"

import { backendNameKey } from "../helpers/backend-name-key.ts"

const norm = backendNameKey

type FixturePlace = ResolvedPlace & { aliases?: string[] }

const PLACES: FixturePlace[] = [
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
		lon: 20,
		score: 5,
		exactMatch: true,
	},

	{ id: 900, name: "97-200", placetype: "postalcode", country: "PL", lat: 51.53, lon: 20.01, score: 1 },

	{
		id: 10,
		name: "Springfield",
		placetype: "locality",
		country: "US",
		lat: 37.19,
		lon: -93.29,
		score: 8,
		prominence: 5.23,
		exactMatch: true,
	},
	{
		id: 11,
		name: "Springfield",
		placetype: "locality",
		country: "US",
		lat: 39.78,
		lon: -89.64,
		score: 7,
		prominence: 5.19,
		exactMatch: true,
	},
	{
		id: 12,
		name: "Springfield",
		placetype: "locality",
		country: "US",
		lat: 42.1,
		lon: -72.59,
		score: 6,
		prominence: 5.05,
		exactMatch: true,
	},

	{
		id: 13,
		name: "Springfield",
		placetype: "locality",
		country: "US",
		lat: 39.8,
		lon: -89.7,
		score: 4,
		prominence: 4.1,
		exactMatch: true,
	},

	{ id: 901, name: "62701", placetype: "postalcode", country: "US", lat: 39.79, lon: -89.65, score: 1 },

	{
		id: 20,
		name: "Grudziądzek",
		placetype: "locality",
		country: "PL",
		lat: 53.4,
		lon: 18.7,
		score: 9,
		exactMatch: true,
	},

	{
		id: 30,
		name: "Москва",
		aliases: ["Moscow"],
		placetype: "locality",
		country: "RU",
		lat: 55.75,
		lon: 37.62,
		score: 10,
		prominence: 6.1,
		exactMatch: true,
	},
	{
		id: 31,
		name: "Moscow",
		placetype: "locality",
		country: "US",
		lat: 46.73,
		lon: -117,
		score: 9,
		prominence: 4.4,
		exactMatch: true,
	},
	{
		id: 32,
		name: "Moscow",
		placetype: "locality",
		country: "US",
		lat: 38.94,
		lon: -90.93,
		score: 8,
		prominence: 3.6,
		exactMatch: true,
	},

	{ id: 902, name: "83843", placetype: "postalcode", country: "US", lat: 46.73, lon: -116.99, score: 1 },

	{
		id: 40,
		name: "New York",
		aliases: ["New York City"],
		placetype: "locality",
		country: "US",
		lat: 40.71,
		lon: -74.01,
		score: 11,
		prominence: 7,
		exactMatch: true,
	},

	{ id: 60, name: "Ave", placetype: "locality", country: "FR", lat: 43.7, lon: 4.6, score: 2, exactMatch: true },
	{
		id: 61,
		name: "Eden Prairie",
		placetype: "locality",
		country: "US",
		lat: 44.85,
		lon: -93.47,
		score: 5,
		exactMatch: true,
	},

	{ id: 50, name: "Wa", placetype: "locality", country: "GH", lat: 10.06, lon: -2.5, score: 20, exactMatch: true },
	{
		id: 51,
		name: "Sammamish",
		placetype: "locality",
		country: "US",
		lat: 47.64,
		lon: -122.08,
		score: 4,
		exactMatch: true,
	},

	{
		id: 60,
		name: "Worth",
		placetype: "locality",
		country: "US",
		lat: 41.687259,
		lon: -87.791282,
		score: 4,
		exactMatch: true,
	},
]

async function makeBackend(): Promise<ResolverBackend> {
	return {
		async findPlace(query) {
			const key = norm(query.text)

			return PLACES.filter(
				(p) =>
					(norm(p.name) === key || (p.aliases?.some((a) => norm(a) === key) ?? false)) &&
					(!query.country || p.country === query.country)
			).map((p) => ({ ...p }))
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
		const raw = "86-300 Grudziądz, Daliowa 4"

		const roots: AddressNode[] = [
			node({ tag: "postcode", value: "86-300", start: 0, end: 6 }),
			node({ tag: "locality", value: "Grudzi", start: 7, end: 13 }),
			node({ tag: "locality", value: "dz", start: 14, end: 16, confidence: 0.9 }),
		]

		const hit = await findRescoreCandidate(raw, roots, await makeBackend(), { country: "PL", postcode: "86-300" })
		expect(hit?.text).toBe("Grudziądz")
		expect(hit?.place.id).toBe(1)

		expect(hit?.postcodeVerified).toBe(false)
	})

	it("prefers the LONGEST exact match (specific name beats its own prefix)", async () => {
		const raw = "Tomaszów Mazowiecki"
		const hit = await findRescoreCandidate(raw, [], await makeBackend(), { country: "PL", thresholdKm: 0 })
		expect(hit?.text).toBe("Tomaszów Mazowiecki")
		expect(hit?.place.id).toBe(3)
		expect(hit?.postcodeVerified).toBe(false)
	})

	it(": orders equal-token spans by CHARACTER extent, so a region code cannot outrun the locality", async () => {
		const hit = await findRescoreCandidate("WA Sammamish", [], await makeBackend(), { thresholdKm: 0 })
		expect(hit?.text).toBe("Sammamish")
		expect(hit?.place.id).toBe(51)
	})

	it(": a sub-span dropping a NAME word is refused under spanRescoreRequireContextRemainder", async () => {
		const backend = await makeBackend()

		const shipped = await findRescoreCandidate("Fort Worth", [], backend, { thresholdKm: 0 })
		expect(shipped?.place.id).toBe(60)

		const ruled = await findRescoreCandidate("Fort Worth", [], backend, {
			thresholdKm: 0,
			spanRescoreRequireContextRemainder: true,
		})

		expect(ruled).toBeNull()
	})

	it(": the rule keeps a sub-span whose remainder is a subdivision code", async () => {
		const hit = await findRescoreCandidate("WA Sammamish", [], await makeBackend(), {
			thresholdKm: 0,
			spanRescoreRequireContextRemainder: true,
		})

		expect(hit?.text).toBe("Sammamish")
		expect(hit?.place.id).toBe(51)
	})

	it(": the rule keeps a sub-span whose remainder is a number", async () => {
		const hit = await findRescoreCandidate("86-300 Grudziądz", [], await makeBackend(), {
			thresholdKm: 0,
			spanRescoreRequireContextRemainder: true,
		})

		expect(hit?.place.id).toBe(1)
	})

	it(": keeps a sub-span whose remainder the PARSE read as a street", async () => {
		const raw = "86-300 Grudziądz, Daliowa 4"

		const roots: AddressNode[] = [
			node({ tag: "postcode", value: "86-300", start: 0, end: 6 }),
			node({ tag: "locality", value: "Grudziądz", start: 7, end: 16 }),
			node({
				tag: "street",
				value: "Daliowa",
				start: 18,
				end: 25,
				children: [node({ tag: "house_number", value: "4", start: 26, end: 27 })],
			}),
		]

		const hit = await findRescoreCandidate(raw, roots, await makeBackend(), {
			thresholdKm: 0,
			spanRescoreRequireContextRemainder: true,
		})

		expect(hit?.place.id).toBe(1)
	})

	it(": a street node OVERLAPPING the span is not context — the `Fort Worth` shape", async () => {
		const raw = "86-300 Grudziądz, Daliowa 4"

		const roots: AddressNode[] = [
			node({ tag: "postcode", value: "86-300", start: 0, end: 6 }),
			node({ tag: "street", value: "Grudziądz, Daliowa", start: 7, end: 25 }),
		]

		const ruled = await findRescoreCandidate(raw, roots, await makeBackend(), {
			thresholdKm: 0,
			spanRescoreRequireContextRemainder: true,
		})

		expect(ruled).toBeNull()
	})

	it("flags a recovery CONDITIONAL when the postcode resolves and the match is within range", async () => {
		const hit = await findRescoreCandidate("Tomaszów Mazowiecki", [], await makeBackend(), {
			country: "PL",
			postcode: "97-200",
			thresholdKm: 50,
		})

		expect(hit?.place.id).toBe(3)
		expect(hit?.postcodeVerified).toBe(true)
	})

	it("postcode check rejects a match far from where the postcode resolves", async () => {
		const hit = await findRescoreCandidate("Tomaszów", [], await makeBackend(), {
			country: "PL",
			postcode: "97-200",
			thresholdKm: 50,
		})

		expect(hit).toBeNull()
	})

	it(": carries the same-span namesake runner-ups, in rank order, without moving the winner", async () => {
		const hit = await findRescoreCandidate("Springfield", [], await makeBackend(), { country: "US", thresholdKm: 0 })

		expect(hit?.place.id).toBe(10)
		expect(hit?.alternatives.map((a) => a.id)).toEqual([11, 12, 13])
	})

	it(": the postcode check filters the runner-ups on the same rule as the winner", async () => {
		const hit = await findRescoreCandidate("Springfield", [], await makeBackend(), {
			country: "US",
			postcode: "62701",
			thresholdKm: 50,
		})

		expect(hit?.place.id).toBe(11)
		expect(hit?.postcodeVerified).toBe(true)
		expect(hit?.alternatives.map((a) => a.id)).toEqual([13])
	})

	it(": a lone namesake yields an empty runner-up list", async () => {
		const hit = await findRescoreCandidate("Grudziądzek", [], await makeBackend(), { country: "PL", thresholdKm: 0 })
		expect(hit?.place.id).toBe(20)
		expect(hit?.alternatives).toEqual([])
	})

	it(": admits a non-Latin-primary namesake via its alias surface — population-first then picks it", async () => {
		const hit = await findRescoreCandidate("Moscow", [], await makeBackend(), { thresholdKm: 0 })
		expect(hit?.place.id).toBe(30)
		expect(hit?.place.name).toBe("Москва")
		expect(hit?.alternatives.map((a) => a.id)).toEqual([31, 32])
	})

	it(": the postcode check still rejects the non-Latin namesake when it is far from the anchor", async () => {
		const hit = await findRescoreCandidate("Moscow", [], await makeBackend(), {
			country: "US",
			postcode: "83843",
			thresholdKm: 50,
		})

		expect(hit?.place.id).toBe(31)
		expect(hit?.postcodeVerified).toBe(true)
	})

	it(": the alias surface is the recall for Latin scripts too (query equals an ALIAS, not the primary)", async () => {
		const hit = await findRescoreCandidate("New York City", [], await makeBackend(), { thresholdKm: 0 })
		expect(hit?.place.id).toBe(40)
		expect(hit?.alternatives).toEqual([])
	})

	it("A span EQUAL to a confident street suffix is refused — the Ave, France condition", async () => {
		const raw = "350 5th Ave"

		const roots: AddressNode[] = [
			node({ tag: "house_number", value: "350", start: 0, end: 3, confidence: 0.95 }),
			node({ tag: "street", value: "5th", start: 4, end: 7, confidence: 0.95 }),
			node({ tag: "street_suffix", value: "Ave", start: 8, end: 11, confidence: 0.95 }),
		]

		expect(await findRescoreCandidate(raw, roots, await makeBackend(), { thresholdKm: 0 })).toBeNull()
	})

	it(": a span CONTAINING a confident street suffix is probed — the suffix is one token of a longer name", async () => {
		const raw = "MN Eden Prairie"

		const roots: AddressNode[] = [
			node({ tag: "street", value: "MN Eden", start: 0, end: 7, confidence: 0.61 }),
			node({ tag: "street_suffix", value: "Prairie", start: 8, end: 15, confidence: 0.86 }),
		]

		const hit = await findRescoreCandidate(raw, roots, await makeBackend(), { thresholdKm: 0 })

		expect(hit?.text).toBe("Eden Prairie")
		expect(hit?.place.id).toBe(61)
	})

	it("Skips a span overlapping a confident street/house_number/postcode constituent", async () => {
		const raw = "Grudziądz 4"
		const roots: AddressNode[] = [node({ tag: "postcode", value: "Grudziądz", start: 0, end: 9, confidence: 0.95 })]
		const hit = await findRescoreCandidate(raw, roots, await makeBackend(), { country: "PL", thresholdKm: 0 })
		expect(hit).toBeNull()
	})
})

describe("hasResolvedPlace", () => {
	const resolvedNode = (metadata: Record<string, unknown> = {}): AddressNode => ({
		...node({ tag: "locality", value: "x", start: 0, end: 1 }),
		placeID: "wof:1",
		metadata,
	})

	it("detects a resolved node anywhere in the tree", () => {
		expect(hasResolvedPlace([node({ tag: "locality", value: "x", start: 0, end: 1 })])).toBe(false)
		expect(hasResolvedPlace([resolvedNode()])).toBe(true)
	})

	it(": each reading holds the brake on the evidence it does NOT name", () => {
		const scoreOnly = resolvedNode({ resolver_score: 0 })
		const containmentOnly = resolvedNode({ admin_containment: "no_contained_candidate" })

		expect(hasResolvedPlace([scoreOnly], "score")).toBe(false)
		expect(hasResolvedPlace([scoreOnly], "containment")).toBe(true)
		expect(hasResolvedPlace([containmentOnly], "score")).toBe(true)
		expect(hasResolvedPlace([containmentOnly], "containment")).toBe(false)

		for (const weak of [scoreOnly, containmentOnly]) {
			expect(hasResolvedPlace([weak], "either")).toBe(false)

			expect(hasResolvedPlace([weak])).toBe(true)
		}
	})

	it(": a backend that could not answer containment is not a weak resolution", () => {
		expect(hasResolvedPlace([resolvedNode({ admin_containment: "unavailable" })], "either")).toBe(true)
	})

	it(": a recorded population holds the brake under every reading", () => {
		const strong = resolvedNode({ resolver_score: 155_226, admin_containment: "contained" })

		for (const reading of ["score", "containment", "either"] as const) {
			expect(hasResolvedPlace([strong], reading)).toBe(true)
		}
	})
})

describe("resolveTree + spanRescore", () => {
	const tree = (raw: string, roots: AddressNode[]): AddressTree => ({ raw, roots })

	it("injects a resolved locality when the tree resolved nothing (opt-in)", async () => {
		const resolver = createWOFResolver(await makeBackend())

		const input = tree("86-300 Grudziądz, Daliowa 4", [
			node({ tag: "locality", value: "Grudzi", start: 7, end: 13 }),
			node({ tag: "locality", value: "dz", start: 14, end: 16 }),
		])

		const out = await resolver.resolveTree(input, { defaultCountry: "PL", spanRescore: true })
		const injected = out.roots.find((n) => n.placeID === "wof:1")
		expect(injected).toBeDefined()
		expect(injected?.tag).toBe("locality")
		expect(injected?.value).toBe("Grudziądz")
		expect(injected?.lat).toBe(53.48)
		expect(injected?.metadata?.span_rescore).toBe(true)

		expect(injected?.metadata?.rescore_postcode_verified).toBe(false)
	})

	it("Injects by default when spanRescore is unset ( promoted to default-on 2026-06-25)", async () => {
		const resolver = createWOFResolver(await makeBackend())

		const input = tree("86-300 Grudziądz, Daliowa 4", [
			node({ tag: "locality", value: "Grudzi", start: 7, end: 13 }),
			node({ tag: "locality", value: "dz", start: 14, end: 16 }),
		])

		const out = await resolver.resolveTree(input, { defaultCountry: "PL" })
		expect(out.roots.find((n) => n.placeID === "wof:1")?.value).toBe("Grudziądz")
	})

	it("Is byte-stable when spanRescore is false (explicit opt-out — the /byte-stable interface)", async () => {
		const resolver = createWOFResolver(await makeBackend())
		const roots = [node({ tag: "locality", value: "Grudzi", start: 7, end: 13 })]

		const out = await resolver.resolveTree(tree("86-300 Grudziądz", roots), {
			defaultCountry: "PL",
			spanRescore: false,
		})

		expect(out.roots.some((n) => n.placeID)).toBe(false)
		expect(out.roots).toHaveLength(1)
	})

	it(": the injected node carries the namesake runner-ups on `alternatives`", async () => {
		const resolver = createWOFResolver(await makeBackend())

		const out = await resolver.resolveTree(
			tree("Springfield", [node({ tag: "street", value: "Springfield", start: 0, end: 11, confidence: 0.4 })]),
			{
				defaultCountry: "US",
			}
		)

		const injected = out.roots.find((n) => n.metadata?.span_rescore === true)
		expect(injected?.placeID).toBe("wof:10")

		expect(injected?.lat).toBe(37.19)
		expect((injected?.alternatives as ResolvedPlace[] | undefined)?.map((a) => a.id)).toEqual([11, 12, 13])
	})

	it(": `alternatives` stays ABSENT (not empty) for a lone namesake — the walk path's interface", async () => {
		const resolver = createWOFResolver(await makeBackend())

		const out = await resolver.resolveTree(
			tree("Grudziądzek", [node({ tag: "street", value: "Grudziądzek", start: 0, end: 11, confidence: 0.4 })]),
			{ defaultCountry: "PL" }
		)

		const injected = out.roots.find((n) => n.metadata?.span_rescore === true)
		expect(injected?.placeID).toBe("wof:20")
		expect(injected?.alternatives).toBeUndefined()
	})

	it(": the injected node for a bare Moscow is Москва RU — the winner flips only for the starved class", async () => {
		const resolver = createWOFResolver(await makeBackend())

		const out = await resolver.resolveTree(
			tree("Moscow", [node({ tag: "street", value: "Moscow", start: 0, end: 7, confidence: 0.4 })]),
			{}
		)

		const injected = out.roots.find((n) => n.metadata?.span_rescore === true)
		expect(injected?.placeID).toBe("wof:30")
		expect(injected?.lat).toBe(55.75)
		expect((injected?.alternatives as ResolvedPlace[] | undefined)?.map((a) => a.id)).toEqual([31, 32])
	})

	it("Does not fire when the tree already resolved (the brake)", async () => {
		const resolver = createWOFResolver(await makeBackend())

		const out = await resolver.resolveTree(
			tree("Grudziądz", [node({ tag: "locality", value: "Grudziądz", start: 0, end: 9 })]),
			{
				defaultCountry: "PL",
				spanRescore: true,
			}
		)

		expect(out.roots.filter((n) => n.tag === "locality")).toHaveLength(1)
	})
})

describe("Multi-token name interiors ( thread 3)", () => {
	it("refuses a sub-span interior to a multi-token country name", async () => {
		const raw = "Papua New Guinea"

		const roots: AddressNode[] = [
			{ tag: "country", value: raw, start: 0, end: raw.length, confidence: 0.68, children: [] } as AddressNode,
		]

		const probed: string[] = []

		const backend = {
			async findPlace({ text }: { text: string }) {
				probed.push(text)

				return []
			},
		} as ResolverBackend

		await findRescoreCandidate(raw, roots, backend, {})

		expect(probed).not.toContain("New")
		expect(probed).not.toContain("Papua")
		expect(probed).not.toContain("Guinea")
	})

	it("leaves a single-token country span probeable — there is no interior to protect", async () => {
		const raw = "Japan"

		const roots: AddressNode[] = [
			{ tag: "country", value: raw, start: 0, end: raw.length, confidence: 0.9, children: [] } as AddressNode,
		]

		const probed: string[] = []

		const backend = {
			async findPlace({ text }: { text: string }) {
				probed.push(text)

				return []
			},
		} as ResolverBackend

		await findRescoreCandidate(raw, roots, backend, {})

		expect(probed).toContain("Japan")
	})
})
