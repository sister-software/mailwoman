/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for the #370 span-rescore: the pure `findRescoreCandidate` (raw-token enumeration, longest-
 *   wins, postcode gate) and its `resolveTree` integration (opt-in injection, the #685 brake, byte-
 *   stability when the flag is unset). A fixture backend stands in for the gazetteer.
 */

import type { AddressNode, AddressTree } from "@mailwoman/core/decoder"
import type { ResolvedPlace, ResolverBackend } from "@mailwoman/core/resolver"
import { createWOFResolver } from "@mailwoman/resolver/resolve"
import { findRescoreCandidate, hasResolvedPlace } from "@mailwoman/resolver/span-rescore"
import { describe, expect, it } from "vitest"

import { backendNameKey } from "#test/backend-name-key"

const norm = backendNameKey

/**
 * A tiny gazetteer: exact-normalized-name matches only (so the walk can't fuzzy-resolve fragments), with an optional
 * ALIAS surface per place — a row admitted by an alias stands in for the gazetteer's names table / alt_names bag, which
 * is what stamps the backend's `exactMatch` on name-OR-alias equality.
 */
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
		lon: 20,
		score: 5,
		exactMatch: true,
	},
	// A postcode → point, near Tomaszów Mazowiecki (the gate anchor).
	{ id: 900, name: "97-200", placetype: "postalcode", country: "PL", lat: 51.53, lon: 20.01, score: 1 },
	// #1537 namesake group: four same-named US localities, rank order as listed. The model reads a bare
	// "Springfield" as a `street`, so the admin walk never touches it and span-rescore is the only tier
	// that resolves it — which is why the runner-ups have to survive THIS path to reach a consumer.
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
	// Sits ~5 km from id 11 — the one same-name candidate that SURVIVES a 62701-anchored gate alongside it.
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
	// The gate anchor for the namesake group — resolves next to id 11 (IL).
	{ id: 901, name: "62701", placetype: "postalcode", country: "US", lat: 39.79, lon: -89.65, score: 1 },
	// A lone namesake: one place, one name. The "absent, not empty" case.
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
	// #1546: the non-Latin-primary namesake, modeled on the LIVE shipped board. Moscow RU (pop 12.7M,
	// primary "Москва") is admitted to a "Moscow" query ONLY through its alias surface — the backend
	// stamps exactMatch via the "Moscow" names row — and it ranks FIRST (population-first). The old
	// span-rescore filter re-checked the PRIMARY name folded to [a-z0-9 ], and norm("Москва") is ""
	// — so the RU entry was dropped and Moscow, Idaho won by default among the Latin-named bearers.
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
	// The gate anchor for the #1546 group — resolves next to the Idaho bearer (id 31).
	{ id: 902, name: "83843", placetype: "postalcode", country: "US", lat: 46.73, lon: -116.99, score: 1 },
	// #1546: the alias surface is the recall for LATIN scripts too — a query equal to a place's ALIAS
	// ("New York City") but not its primary name ("New York") was dropped by the same primary-name
	// re-check, even when the backend had already flagged it exact.
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
		// The model split "Grudziądz" into "Grudzi" + "dz"; neither resolves. The raw word is intact.
		const raw = "86-300 Grudziądz, Daliowa 4"

		const roots: AddressNode[] = [
			node({ tag: "postcode", value: "86-300", start: 0, end: 6 }),
			node({ tag: "locality", value: "Grudzi", start: 7, end: 13 }),
			node({ tag: "locality", value: "dz", start: 14, end: 16, confidence: 0.9 }),
		]

		const hit = await findRescoreCandidate(raw, roots, await makeBackend(), { country: "PL", postcode: "86-300" })
		expect(hit?.text).toBe("Grudziądz")
		expect(hit?.place.id).toBe(1)
		// 86-300 isn't in the fixture → no anchor → unrestricted (flagged lower-precision).
		expect(hit?.gated).toBe(false)
	})

	it("prefers the LONGEST exact match (specific name beats its own prefix)", async () => {
		const raw = "Tomaszów Mazowiecki" // gold is the longer name; shortest-wins would grab "Tomaszów"
		const hit = await findRescoreCandidate(raw, [], await makeBackend(), { country: "PL", gateKm: 0 })
		expect(hit?.text).toBe("Tomaszów Mazowiecki")
		expect(hit?.place.id).toBe(3)
		expect(hit?.gated).toBe(false) // gate disabled (gateKm 0)
	})

	it("flags a recovery GATED when the postcode resolves and the match is within range", async () => {
		// 97-200 resolves (fixture) near Tomaszów Mazowiecki; the longest match lands within 50km → gated.
		const hit = await findRescoreCandidate("Tomaszów Mazowiecki", [], await makeBackend(), {
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
		const hit = await findRescoreCandidate("Tomaszów", [], await makeBackend(), {
			country: "PL",
			postcode: "97-200",
			gateKm: 50,
		})

		expect(hit).toBeNull()
	})

	it("#1537: carries the same-span namesake runner-ups, in rank order, without moving the winner", async () => {
		const hit = await findRescoreCandidate("Springfield", [], await makeBackend(), { country: "US", gateKm: 0 })

		// The winner is what it always was — the first exact match in the backend's rank order.
		expect(hit?.place.id).toBe(10)
		expect(hit?.alternatives.map((a) => a.id)).toEqual([11, 12, 13])
	})

	it("#1537: the postcode gate filters the runner-ups on the same rule as the winner", async () => {
		// 62701 anchors next to id 11 (IL). MO (id 10) and MA (id 12) are >50 km out, so the gate drops them
		// from BOTH roles: id 11 wins, and only the ~5 km id 13 survives as an alternative. A candidate the
		// postcode already excluded is not a namesake worth offering.
		const hit = await findRescoreCandidate("Springfield", [], await makeBackend(), {
			country: "US",
			postcode: "62701",
			gateKm: 50,
		})

		expect(hit?.place.id).toBe(11)
		expect(hit?.gated).toBe(true)
		expect(hit?.alternatives.map((a) => a.id)).toEqual([13])
	})

	it("#1537: a lone namesake yields an empty runner-up list", async () => {
		const hit = await findRescoreCandidate("Grudziądzek", [], await makeBackend(), { country: "PL", gateKm: 0 })
		expect(hit?.place.id).toBe(20)
		expect(hit?.alternatives).toEqual([])
	})

	it("#1546: admits a non-Latin-primary namesake via its alias surface — population-first then picks it", async () => {
		// The live Moscow board: the backend returns Moscow RU FIRST (exactMatch via the "Moscow" alias
		// row), but the old filter re-checked only the PRIMARY name folded to [a-z0-9 ] — norm("Москва")
		// is "" and could never equal "moscow", so Moscow, Idaho won by default among the Latin-named
		// bearers. Population-first ranking was starved, not violated; recall fixes it with no ranking
		// change.
		const hit = await findRescoreCandidate("Moscow", [], await makeBackend(), { gateKm: 0 })
		expect(hit?.place.id).toBe(30)
		expect(hit?.place.name).toBe("Москва")
		expect(hit?.alternatives.map((a) => a.id)).toEqual([31, 32])
	})

	it("#1546: the postcode gate still rejects the non-Latin namesake when it is far from the anchor", async () => {
		// "Moscow, ID 83843": the postcode anchors next to the Idaho bearer (id 31); Moscow RU is
		// thousands of km away, so the gate excludes it and the Idaho winner is unchanged. Admission is
		// recall; the gate still decides.
		const hit = await findRescoreCandidate("Moscow", [], await makeBackend(), {
			country: "US",
			postcode: "83843",
			gateKm: 50,
		})

		expect(hit?.place.id).toBe(31)
		expect(hit?.gated).toBe(true)
	})

	it("#1546: the alias surface is the recall for Latin scripts too (query equals an ALIAS, not the primary)", async () => {
		// "New York City" matches New York only through its alias row. The old primary-name re-check
		// (norm("New York") !== norm("New York City")) dropped the exact match the backend had already
		// flagged — the same recall defect, without any non-Latin script.
		const hit = await findRescoreCandidate("New York City", [], await makeBackend(), { gateKm: 0 })
		expect(hit?.place.id).toBe(40)
		expect(hit?.alternatives).toEqual([])
	})

	it("skips a span overlapping a confident street/house_number/postcode constituent", async () => {
		// "Grudziądz" sits where a confident postcode node is declared → not eligible as a locality span.
		const raw = "Grudziądz 4"
		const roots: AddressNode[] = [node({ tag: "postcode", value: "Grudziądz", start: 0, end: 9, confidence: 0.95 })]
		const hit = await findRescoreCandidate(raw, roots, await makeBackend(), { country: "PL", gateKm: 0 })
		expect(hit).toBeNull()
	})
})

describe("hasResolvedPlace", () => {
	it("detects a resolved node anywhere in the tree", () => {
		expect(hasResolvedPlace([node({ tag: "locality", value: "x", start: 0, end: 1 })])).toBe(false)
		const resolved = node({ tag: "locality", value: "x", start: 0, end: 1 })
		resolved.placeID = "wof:1"
		expect(hasResolvedPlace([resolved])).toBe(true)
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
		// No postcode node in this tree → no anchor → unrestricted, flagged so the consumer can threshold.
		expect(injected?.metadata?.rescore_gated).toBe(false)
	})

	it("injects by default when spanRescore is unset (#370 promoted to default-on 2026-06-25)", async () => {
		const resolver = createWOFResolver(await makeBackend())

		const input = tree("86-300 Grudziądz, Daliowa 4", [
			node({ tag: "locality", value: "Grudzi", start: 7, end: 13 }),
			node({ tag: "locality", value: "dz", start: 14, end: 16 }),
		])

		// No `spanRescore` in opts — the default (ON) must still recover the locality.
		const out = await resolver.resolveTree(input, { defaultCountry: "PL" })
		expect(out.roots.find((n) => n.placeID === "wof:1")?.value).toBe("Grudziądz")
	})

	it("is byte-stable when spanRescore is false (explicit opt-out — the #685/byte-stable contract)", async () => {
		const resolver = createWOFResolver(await makeBackend())
		const roots = [node({ tag: "locality", value: "Grudzi", start: 7, end: 13 })]

		const out = await resolver.resolveTree(tree("86-300 Grudziądz", roots), {
			defaultCountry: "PL",
			spanRescore: false,
		})

		expect(out.roots.some((n) => n.placeID)).toBe(false)
		expect(out.roots).toHaveLength(1)
	})

	it("#1537: the injected node carries the namesake runner-ups on `alternatives`", async () => {
		const resolver = createWOFResolver(await makeBackend())

		// The live shape: the model tags a bare famous namesake as a `street`, so the admin walk resolves
		// nothing and span-rescore is what recovers it. Before #1537 this node was decorated with an empty
		// alternatives list, so the geocode path's candidate array held ONE entry and the dominance margin
		// `declared_ambiguity` reads could not be computed at all.
		const out = await resolver.resolveTree(
			tree("Springfield", [node({ tag: "street", value: "Springfield", start: 0, end: 11, confidence: 0.4 })]),
			{
				defaultCountry: "US",
			}
		)

		const injected = out.roots.find((n) => n.metadata?.span_rescore === true)
		expect(injected?.placeID).toBe("wof:10")
		// Unchanged winner: the coordinate this query answered with before the fix.
		expect(injected?.lat).toBe(37.19)
		expect((injected?.alternatives as ResolvedPlace[] | undefined)?.map((a) => a.id)).toEqual([11, 12, 13])
	})

	it("#1537: `alternatives` stays ABSENT (not empty) for a lone namesake — the walk path's contract", async () => {
		const resolver = createWOFResolver(await makeBackend())

		const out = await resolver.resolveTree(
			tree("Grudziądzek", [node({ tag: "street", value: "Grudziądzek", start: 0, end: 11, confidence: 0.4 })]),
			{ defaultCountry: "PL" }
		)

		const injected = out.roots.find((n) => n.metadata?.span_rescore === true)
		expect(injected?.placeID).toBe("wof:20")
		expect(injected?.alternatives).toBeUndefined()
	})

	it("#1546: the injected node for a bare Moscow is Москва RU — the winner flips only for the starved class", async () => {
		const resolver = createWOFResolver(await makeBackend())

		// The live shape: a bare famous namesake reads as a `street` (no country prior — the #912 lever
		// abstains on a bare-locality tree), the walk resolves nothing, span-rescore recovers it. Before
		// the fix the recovered place was Moscow, Idaho: Moscow RU never entered the candidate list.
		const out = await resolver.resolveTree(
			tree("Moscow", [node({ tag: "street", value: "Moscow", start: 0, end: 7, confidence: 0.4 })]),
			{}
		)

		const injected = out.roots.find((n) => n.metadata?.span_rescore === true)
		expect(injected?.placeID).toBe("wof:30")
		expect(injected?.lat).toBe(55.75)
		expect((injected?.alternatives as ResolvedPlace[] | undefined)?.map((a) => a.id)).toEqual([31, 32])
	})

	it("does not fire when the tree already resolved (the #685 brake)", async () => {
		const resolver = createWOFResolver(await makeBackend())

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

describe("multi-token name interiors (#1678 thread 3)", () => {
	/**
	 * `Papua New Guinea` is absent from the gazetteer, so the tree resolves nothing and the rescore tier runs. Before
	 * this guard it enumerated raw token spans, matched the interior `New` against a real US place, and pinned the
	 * address to Kentucky — a confident answer to a question nobody asked. The parse was correct throughout.
	 */
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

		// The whole span may be probed; its interior tokens may not.
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
