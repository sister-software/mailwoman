import type { ComponentTag } from "@mailwoman/codex/component"
import { expandPlacetypeFilter } from "@mailwoman/codex/placetype-map"
import type { AddressNode, Interpretation, AddressTree } from "@mailwoman/core/decoder"
import { decodeAsXML, walkNodes } from "@mailwoman/core/decoder"
import { stringifyJSON } from "@mailwoman/core/json"
import type {
	Ancestor,
	AddressPointLookup,
	CoincidentLocality,
	InterpolationLookup,
	ResolvedPlace,
	ResolverBackend,
	StreetCentroidLookup,
} from "@mailwoman/core/resolver"
import { createWOFResolver } from "@mailwoman/resolver/resolve"
import { describe, expect, test, vi } from "vitest"

function node(
	tag: ComponentTag,
	value: string,
	start: number,
	end: number,
	children: AddressNode[] = [],
	source?: string,
	sourceID?: string
): AddressNode {
	const n: AddressNode = { tag, value, start, end, confidence: 0.9, children }

	if (source) {
		n.source = source
	}

	if (sourceID) {
		n.sourceID = sourceID
	}

	return n
}

function tree(raw: string, roots: AddressNode[]): AddressTree {
	return { raw, roots }
}

class FakeResolverBackend implements ResolverBackend {
	readonly calls: Array<Parameters<ResolverBackend["findPlace"]>[0]> = []
	readonly #places: ResolvedPlace[]
	readonly #coincident: Map<number, CoincidentLocality[]>
	readonly #ancestors: Map<number, Ancestor[]>

	constructor(
		places: ResolvedPlace[],
		coincident?: Map<number, CoincidentLocality[]>,
		ancestors?: Map<number, Ancestor[]>
	) {
		this.#places = places
		this.#coincident = coincident ?? new Map()
		this.#ancestors = ancestors ?? new Map()
	}

	async findPlace(query: Parameters<ResolverBackend["findPlace"]>[0]): Promise<ResolvedPlace[]> {
		this.calls.push(query)
		const text = query.text.toLowerCase()
		const requested = Array.isArray(query.placetype) ? query.placetype : query.placetype ? [query.placetype] : null

		const types = expandPlacetypeFilter(requested)

		return this.#places
			.filter((p) => p.name.toLowerCase().includes(text))
			.filter((p) => !types || types.includes(p.placetype))
			.filter((p) => !query.country || p.country === query.country)
			.filter((p) => query.parentID === undefined || p.parent_id === query.parentID)
			.slice(0, query.limit ?? 5)
	}

	coincidentLocalitiesFor(adminID: number | string): CoincidentLocality[] {
		return this.#coincident.get(Number(adminID)) ?? []
	}

	ancestors(id: number | string): Ancestor[] {
		return this.#ancestors.get(Number(id)) ?? []
	}
}

const FIXTURE_PLACES: ResolvedPlace[] = [
	{ id: 85_633_147, name: "United States", placetype: "country", country: "US", lat: 39.5, lon: -98, score: 10 },
	{ id: 85_633_723, name: "France", placetype: "country", country: "FR", lat: 46.5, lon: 2.5, score: 10 },
	{
		id: 85_688_489,
		name: "Texas",
		placetype: "region",
		country: "US",
		parent_id: 85_633_147,
		lat: 31,
		lon: -100,
		score: 9,
	},
	{
		id: 85_688_541,
		name: "Illinois",
		placetype: "region",
		country: "US",
		parent_id: 85_633_147,
		lat: 40,
		lon: -89,
		score: 9,
	},
	{
		id: 101_715_829,
		name: "Paris",
		placetype: "locality",
		country: "US",
		parent_id: 85_688_489,
		lat: 33.66,
		lon: -95.55,
		score: 8,
	},
	{
		id: 101_727_113,
		name: "Springfield",
		placetype: "locality",
		country: "US",
		parent_id: 85_688_541,
		lat: 39.78,
		lon: -89.65,
		score: 8,
	},
	{
		id: 101_729_437,
		name: "Springfield",
		placetype: "locality",
		country: "US",
		parent_id: 85_688_543,
		lat: 42.1,
		lon: -72.59,
		score: 8,
	},
]

describe("resolveTree", () => {
	test("decorates a matched node with resolver source + sourceID + lat/lon + placeID", async () => {
		const backend = new FakeResolverBackend(FIXTURE_PLACES)
		const resolver = createWOFResolver(backend)

		const input = tree("Texas", [node("region", "Texas", 0, 5)])
		const result = await resolver.resolveTree(input)

		expect(result.roots[0]).toMatchObject({
			tag: "region",
			value: "Texas",
			source: "resolver",
			sourceID: "region:85688489",
			lat: 31,
			lon: -100,
			placeID: "wof:85688489",
		})
	})

	test("preserves classifier attribution into metadata when it gets displaced", async () => {
		const backend = new FakeResolverBackend(FIXTURE_PLACES)
		const resolver = createWOFResolver(backend)

		const input = tree("Texas", [node("region", "Texas", 0, 5, [], "rule", "whos_on_first")])
		const result = await resolver.resolveTree(input)

		expect(result.roots[0]?.source).toBe("resolver")

		expect(result.roots[0]?.metadata).toMatchObject({
			classifier_source: "rule",
			classifier_source_id: "whos_on_first",
		})
	})

	test("leaves the node untouched when no candidates match", async () => {
		const backend = new FakeResolverBackend(FIXTURE_PLACES)
		const resolver = createWOFResolver(backend)

		const input = tree("Nowheresville", [node("locality", "Nowheresville", 0, 13, [], "neural", "v1")])
		const result = await resolver.resolveTree(input)

		expect(result.roots[0]?.source).toBe("neural")
		expect(result.roots[0]?.sourceID).toBe("v1")
		expect(result.roots[0]?.lat).toBeUndefined()
		expect(result.roots[0]?.placeID).toBeUndefined()
		expect(result.roots[0]?.metadata).toBeUndefined()
	})

	test("does NOT mutate the input tree", async () => {
		const backend = new FakeResolverBackend(FIXTURE_PLACES)
		const resolver = createWOFResolver(backend)

		const input = tree("Texas", [node("region", "Texas", 0, 5, [], "rule", "whos_on_first")])
		const before = stringifyJSON(input)
		await resolver.resolveTree(input)
		expect(stringifyJSON(input)).toBe(before)
	})

	test("skips nodes whose tag isn't in the placetype map (street / house_number / etc)", async () => {
		const backend = new FakeResolverBackend(FIXTURE_PLACES)
		const resolver = createWOFResolver(backend)

		const input = tree("123 Main St", [node("street", "Main St", 4, 11), node("house_number", "123", 0, 3)])
		await resolver.resolveTree(input)
		expect(backend.calls).toHaveLength(0)
	})

	test("inherits parent's country code into child queries", async () => {
		const backend = new FakeResolverBackend(FIXTURE_PLACES)
		const resolver = createWOFResolver(backend)

		const input = tree("Texas, Paris", [node("region", "Texas", 0, 5, [node("locality", "Paris", 7, 12)])])
		await resolver.resolveTree(input)

		expect(backend.calls[0]).toMatchObject({ text: "Texas", placetype: "region" })
		expect(backend.calls[0]).not.toHaveProperty("country")

		expect(backend.calls[1]).toMatchObject({ text: "Paris", placetype: "locality", country: "US" })
	})

	test("inherits parent's id into child queries via parentID", async () => {
		const backend = new FakeResolverBackend(FIXTURE_PLACES)
		const resolver = createWOFResolver(backend)

		const input = tree("Illinois, Springfield", [
			node("region", "Illinois", 0, 8, [node("locality", "Springfield", 10, 21)]),
		])

		const result = await resolver.resolveTree(input)

		expect(backend.calls[1]).toMatchObject({
			text: "Springfield",
			placetype: "locality",
			parentID: 85_688_541,
		})

		expect(result.roots[0]?.children[0]?.placeID).toBe("wof:101727113")
	})

	test("HardCountry: a confident placer country is a HARD filter, winning over a higher-scored foreign namesake", async () => {
		const places: ResolvedPlace[] = [
			{ id: 1, name: "Pori", placetype: "locality", country: "FI", lat: 61.48, lon: 21.79, score: 8 },
			{ id: 2, name: "Pori", placetype: "locality", country: "US", lat: 40, lon: -90, score: 9 },
		]

		const backend = new FakeResolverBackend(places)
		const resolver = createWOFResolver(backend)

		const input = tree("Pori", [node("locality", "Pori", 0, 4)])
		const result = await resolver.resolveTree(input, { hardCountry: "FI" })

		expect(result.roots[0]).toMatchObject({ placeID: "wof:1", lat: 61.48 })

		expect(backend.calls).toHaveLength(3)
		expect(backend.calls.every((c) => c.country === "FI")).toBe(true)
	})

	test("HardCountry miss → node left UNRESOLVED, with NO global retry (the in-region-or-unresolved interface)", async () => {
		const places: ResolvedPlace[] = [
			{ id: 3, name: "Lyon", placetype: "locality", country: "FR", lat: 45.76, lon: 4.84, score: 9 },
		]

		const backend = new FakeResolverBackend(places)
		const resolver = createWOFResolver(backend)

		const input = tree("Lyon", [node("locality", "Lyon", 0, 4, [], "neural", "v1")])

		const result = await resolver.resolveTree(input, { hardCountry: "FI", spanRescore: false })

		expect(result.roots[0]?.placeID).toBeUndefined()
		expect(result.roots[0]?.lat).toBeUndefined()
		expect(result.roots[0]?.source).toBe("neural")

		expect(backend.calls).toHaveLength(3)
		expect(backend.calls.every((c) => c.country === "FI")).toBe(true)
	})

	test("respects maxLookups budget", async () => {
		const backend = new FakeResolverBackend(FIXTURE_PLACES)
		const resolver = createWOFResolver(backend)

		const input = tree("Texas, Illinois, Paris, Springfield", [
			node("region", "Texas", 0, 5),
			node("region", "Illinois", 7, 15),
			node("locality", "Paris", 17, 22),
			node("locality", "Springfield", 24, 35),
		])

		await resolver.resolveTree(input, { maxLookups: 2 })
		expect(backend.calls).toHaveLength(2)
	})

	test("respects minWinningScore — low-score candidate doesn't win", async () => {
		const backend = new FakeResolverBackend(FIXTURE_PLACES)
		const resolver = createWOFResolver(backend)

		const input = tree("Texas", [node("region", "Texas", 0, 5, [], "rule", "whos_on_first")])
		const result = await resolver.resolveTree(input, { minWinningScore: 100 })

		expect(result.roots[0]?.source).toBe("rule")
		expect(result.roots[0]?.sourceID).toBe("whos_on_first")
		expect(result.roots[0]?.placeID).toBeUndefined()
	})

	test("a minWinningScore refusal is not reopened by span-rescore", async () => {
		const backend = new FakeResolverBackend(FIXTURE_PLACES)
		const resolver = createWOFResolver(backend)

		const input = tree("Paris", [node("locality", "Paris", 0, 5, [], "rule", "whos_on_first")])

		const result = await resolver.resolveTree(input, { minWinningScore: 9 })

		expect(result.roots[0]?.placeID).toBeUndefined()
		expect(result.roots[0]?.source).toBe("rule")
		expect(backend.calls.filter((call) => call.placetype === "locality")).toHaveLength(1)
	})

	test("span-rescore still runs when a tree is unresolved without any refusal", async () => {
		const backend = new FakeResolverBackend(FIXTURE_PLACES)
		const resolver = createWOFResolver(backend)

		const input = tree("Nowhere", [node("locality", "Nowhere", 0, 7)])

		await resolver.resolveTree(input)

		expect(backend.calls.filter((call) => call.placetype === "locality")).toHaveLength(2)
	})

	test("PlacetypeMap override can disable a default mapping", async () => {
		const backend = new FakeResolverBackend(FIXTURE_PLACES)
		const resolver = createWOFResolver(backend)

		const input = tree("Texas", [node("region", "Texas", 0, 5)])

		await resolver.resolveTree(input, { placetypeMap: { country: "country" }, spanRescore: false })

		expect(backend.calls).toHaveLength(0)
	})

	test("backend errors are caught and the node falls through unchanged", async () => {
		const backend: ResolverBackend = {
			async findPlace() {
				throw new Error("backend boom")
			},
		}

		const resolver = createWOFResolver(backend)

		const input = tree("Texas", [node("region", "Texas", 0, 5, [], "rule", "whos_on_first")])
		const result = await resolver.resolveTree(input)
		expect(result.roots[0]?.source).toBe("rule")
		expect(result.roots[0]?.placeID).toBeUndefined()
	})

	test("empty-value node doesn't issue a lookup", async () => {
		const backend = new FakeResolverBackend(FIXTURE_PLACES)
		const resolver = createWOFResolver(backend)

		const input = tree("", [node("region", "  ", 0, 2)])
		await resolver.resolveTree(input)
		expect(backend.calls).toHaveLength(0)
	})

	test("emits lat/lon/place in XML serialization after resolve", async () => {
		const backend = new FakeResolverBackend(FIXTURE_PLACES)
		const resolver = createWOFResolver(backend)

		const input = tree("Texas", [node("region", "Texas", 0, 5)])
		const result = await resolver.resolveTree(input)
		const xml = decodeAsXML(result)

		expect(xml).toContain(`src="resolver:region:85688489"`)
		expect(xml).toContain(`lat="31.000000"`)
		expect(xml).toContain(`lon="-100.000000"`)
		expect(xml).toContain(`place="wof:85688489"`)
	})

	test("XML serializer can suppress geo + place via opts", async () => {
		const backend = new FakeResolverBackend(FIXTURE_PLACES)
		const resolver = createWOFResolver(backend)

		const input = tree("Texas", [node("region", "Texas", 0, 5)])
		const result = await resolver.resolveTree(input)
		const xml = decodeAsXML(result, { includeGeo: false, includePlace: false })

		expect(xml).not.toContain("lat=")
		expect(xml).not.toContain("lon=")
		expect(xml).not.toContain("place=")

		expect(xml).toContain("src=")
	})

	test("backend call site receives candidatesPerLookup as `limit`", async () => {
		const backend = new FakeResolverBackend(FIXTURE_PLACES)
		const findPlaceSpy = vi.spyOn(backend, "findPlace")
		const resolver = createWOFResolver(backend)

		const input = tree("Texas", [node("region", "Texas", 0, 5)])
		await resolver.resolveTree(input, { candidatesPerLookup: 3 })
		expect(findPlaceSpy).toHaveBeenCalledWith(expect.objectContaining({ limit: 3 }))
	})
})

describe("resolveTree — alternatives (candidate-list API)", () => {
	const AMBIG_PLACES: ResolvedPlace[] = [
		{
			id: 101_727_113,
			name: "Springfield",
			placetype: "locality",
			country: "US",
			parent_id: 85_688_541,
			lat: 39.78,
			lon: -89.65,
			score: 8,
		},
		{
			id: 101_728_010,
			name: "Springfield",
			placetype: "locality",
			country: "US",
			parent_id: 85_688_547,
			lat: 37.21,
			lon: -93.29,
			score: 7,
		},
		{
			id: 101_729_887,
			name: "Springfield",
			placetype: "locality",
			country: "US",
			parent_id: 85_688_549,
			lat: 42.1,
			lon: -72.59,
			score: 6,
		},
	]

	test("surfaces runner-up candidates on resolved node", async () => {
		const backend = new FakeResolverBackend(AMBIG_PLACES)
		const resolver = createWOFResolver(backend)

		const input = tree("Springfield", [node("locality", "Springfield", 0, 11)])
		const result = await resolver.resolveTree(input)
		const root = result.roots[0]!

		expect(root.placeID).toBe("wof:101727113")
		expect(root.lat).toBe(39.78)

		expect(root.alternatives).toBeDefined()
		const alts = root.alternatives as ResolvedPlace[]
		expect(alts).toHaveLength(2)
		expect(alts[0]?.id).toBe(101_728_010)
		expect(alts[1]?.id).toBe(101_729_887)
	})

	test("alternatives is absent (not just empty) when only one candidate", async () => {
		const backend = new FakeResolverBackend([AMBIG_PLACES[0]!])
		const resolver = createWOFResolver(backend)

		const input = tree("Springfield", [node("locality", "Springfield", 0, 11)])
		const result = await resolver.resolveTree(input)
		expect(result.roots[0]?.alternatives).toBeUndefined()
	})

	test("alternatives is absent when no candidates resolved", async () => {
		const backend = new FakeResolverBackend([])
		const resolver = createWOFResolver(backend)

		const input = tree("Atlantis", [node("locality", "Atlantis", 0, 8)])
		const result = await resolver.resolveTree(input)
		expect(result.roots[0]?.alternatives).toBeUndefined()
		expect(result.roots[0]?.placeID).toBeUndefined()
	})

	test("alternatives respects candidatesPerLookup (top + alternatives = limit)", async () => {
		const backend = new FakeResolverBackend(AMBIG_PLACES)
		const resolver = createWOFResolver(backend)

		const input = tree("Springfield", [node("locality", "Springfield", 0, 11)])
		const result = await resolver.resolveTree(input, { candidatesPerLookup: 2 })
		const root = result.roots[0]!

		expect(root.placeID).toBe("wof:101727113")
		const alts = root.alternatives as ResolvedPlace[]
		expect(alts).toHaveLength(1)
	})

	test("Anchor posterior re-ranks locality candidates by country, off by default", async () => {
		const berlins: ResolvedPlace[] = [
			{ id: 1, name: "Berlin", placetype: "locality", country: "US", lat: 44.46, lon: -71.18, score: 8 },
			{ id: 2, name: "Berlin", placetype: "locality", country: "DE", lat: 52.52, lon: 13.4, score: 7 },
		]

		const input = tree("Berlin", [node("locality", "Berlin", 0, 6)])

		const off = await createWOFResolver(new FakeResolverBackend(berlins)).resolveTree(input)
		expect(off.roots[0]!.placeID).toBe("wof:1")

		const on = await createWOFResolver(new FakeResolverBackend(berlins)).resolveTree(input, {
			anchorPosterior: { DE: 1 },
		})

		expect(on.roots[0]!.placeID).toBe("wof:2")

		expect((on.roots[0]!.alternatives as ResolvedPlace[])[0]!.id).toBe(1)
	})

	test("Anchor posterior leaves the pick unchanged when it already agrees", async () => {
		const berlins: ResolvedPlace[] = [
			{ id: 1, name: "Berlin", placetype: "locality", country: "US", lat: 44.46, lon: -71.18, score: 8 },
			{ id: 2, name: "Berlin", placetype: "locality", country: "DE", lat: 52.52, lon: 13.4, score: 7 },
		]

		const input = tree("Berlin", [node("locality", "Berlin", 0, 6)])

		const on = await createWOFResolver(new FakeResolverBackend(berlins)).resolveTree(input, {
			anchorPosterior: { US: 1 },
		})

		expect(on.roots[0]!.placeID).toBe("wof:1")
	})

	test("Anchor posterior re-ranks REGION candidates by country, off by default", async () => {
		const regions: ResolvedPlace[] = [
			{ id: 1, name: "Vermontia", placetype: "region", country: "IT", lat: 42.4, lon: 12.1, score: 8 },
			{ id: 2, name: "Vermontia", placetype: "region", country: "US", lat: 44, lon: -72.7, score: 7 },
		]

		const input = tree("Vermontia", [node("region", "Vermontia", 0, 9)])

		const off = await createWOFResolver(new FakeResolverBackend(regions)).resolveTree(input)
		expect(off.roots[0]!.placeID).toBe("wof:1")

		const on = await createWOFResolver(new FakeResolverBackend(regions)).resolveTree(input, {
			anchorPosterior: { US: 1 },
		})

		expect(on.roots[0]!.placeID).toBe("wof:2")
		expect((on.roots[0]!.alternatives as ResolvedPlace[])[0]!.id).toBe(1)
	})

	test("Anchor posterior keeps the EXACT match within the pinned country — tier-safe", async () => {
		const regions: ResolvedPlace[] = [
			{ id: 1, name: "Maineland", placetype: "region", country: "US", lat: 45, lon: -69, score: 5, exactMatch: true },
			{
				id: 2,
				name: "Missouriland",
				placetype: "region",
				country: "US",
				lat: 38,
				lon: -92,
				score: 7,
				exactMatch: false,
			},
			{ id: 3, name: "Messinaland", placetype: "region", country: "IT", lat: 38, lon: 15, score: 6, exactMatch: true },
		]

		const input = tree("land", [node("region", "land", 0, 4)])

		const on = await createWOFResolver(new FakeResolverBackend(regions)).resolveTree(input, {
			anchorPosterior: { US: 1 },
		})

		expect(on.roots[0]!.placeID).toBe("wof:1")
	})

	test("Region span resolves to a macroregion fallback when no exact region exists", async () => {
		const places: ResolvedPlace[] = [
			{ id: 404_227_501, name: "Veneto", placetype: "macroregion", country: "IT", lat: 45.65, lon: 11.86, score: 9 },
		]

		const input = tree("Veneto", [node("region", "Veneto", 0, 6)])
		const out = await createWOFResolver(new FakeResolverBackend(places)).resolveTree(input, { defaultCountry: "IT" })
		const r = out.roots[0]!
		expect(r.placeID).toBe("wof:404227501")
		expect(r.sourceID).toBe("macroregion:404227501")
		expect(r.metadata?.["resolution_quality"]).toBe("fallback")
	})

	test("Exact region is preferred over a same-name macroregion — no fallback annotation", async () => {
		const places: ResolvedPlace[] = [
			{ id: 1, name: "Foo", placetype: "macroregion", country: "IT", lat: 45, lon: 11, score: 9 },
			{ id: 2, name: "Foo", placetype: "region", country: "IT", lat: 46, lon: 12, score: 7 },
		]

		const input = tree("Foo", [node("region", "Foo", 0, 3)])
		const out = await createWOFResolver(new FakeResolverBackend(places)).resolveTree(input, { defaultCountry: "IT" })
		const r = out.roots[0]!
		expect(r.sourceID).toBe("region:2")
		expect(r.metadata?.["resolution_quality"]).toBeUndefined()

		expect((r.alternatives as ResolvedPlace[])[0]!.id).toBe(1)
	})

	test("County/subregion span resolves to a macrocounty fallback", async () => {
		const places: ResolvedPlace[] = [
			{ id: 404_227_567, name: "Oberbayern", placetype: "macrocounty", country: "DE", lat: 48, lon: 11.5, score: 8 },
		]

		const input = tree("Oberbayern", [node("subregion", "Oberbayern", 0, 10)])
		const out = await createWOFResolver(new FakeResolverBackend(places)).resolveTree(input, { defaultCountry: "DE" })
		const r = out.roots[0]!
		expect(r.sourceID).toBe("macrocounty:404227567")
		expect(r.metadata?.["resolution_quality"]).toBe("fallback")
	})

	test("Borough/localadmin under a locality query are NOT fallbacks ( scope condition)", async () => {
		const places: ResolvedPlace[] = [
			{ id: 421_205_765, name: "Brooklyn", placetype: "borough", country: "US", lat: 40.65, lon: -73.95, score: 8 },
		]

		const input = tree("Brooklyn", [node("locality", "Brooklyn", 0, 8)])
		const out = await createWOFResolver(new FakeResolverBackend(places)).resolveTree(input, { defaultCountry: "US" })
		const r = out.roots[0]!
		expect(r.sourceID).toBe("borough:421205765")
		expect(r.metadata?.["resolution_quality"]).toBeUndefined()
	})

	const DUAL_ROLE_PLACES: ResolvedPlace[] = [
		{ id: 900, name: "Germany", placetype: "country", country: "DE", lat: 51.1, lon: 10.4, score: 10 },
		{ id: 910, name: "Berlin", placetype: "region", country: "DE", parent_id: 900, lat: 52.52, lon: 13.4, score: 9 },

		{
			id: 920,
			name: "Brandenburg",
			placetype: "region",
			country: "DE",
			parent_id: 900,
			lat: 52.4,
			lon: 13,
			score: 9,
		},
	]

	const berlinLocality: CoincidentLocality = {
		id: 911,
		name: "Berlin",
		placetype: "locality",
		country: "DE",
		lat: 52.52,
		lon: 13.4,
		score: 0,
		relationshipType: "city-state",
		population: 3_600_000,
		distanceKm: 0,
	}

	const RELATION = new Map<number, CoincidentLocality[]>([[910, [berlinLocality]]])

	const localityRole = (roots: AddressNode[]): Interpretation | undefined =>
		(roots.find((r) => r.tag === "region")?.interpretations as Interpretation[] | undefined)?.find(
			(i) => i.tag === "locality"
		)

	test("Completion records the dropped locality as an interpretation on the region node", async () => {
		const backend = new FakeResolverBackend(DUAL_ROLE_PLACES, RELATION)
		const input = tree("Berlin 10115", [node("region", "Berlin", 0, 6), node("postcode", "10115", 7, 12)])

		const result = await createWOFResolver(backend).resolveTree(input, {
			hierarchyCompletion: true,
			defaultCountry: "DE",
		})

		expect(result.roots.find((r) => r.tag === "locality")).toBeUndefined()

		expect(localityRole(result.roots)).toMatchObject({
			tag: "locality",
			placeID: "wof:911",
			lat: 52.52,
			lon: 13.4,
			metadata: { relationship_type: "city-state", resolver_completed: true },
		})
	})

	test("An explicit hierarchyCompletion: true drives completion, same as the default", async () => {
		const backend = new FakeResolverBackend(DUAL_ROLE_PLACES, RELATION)
		const input = tree("Berlin 10115", [node("region", "Berlin", 0, 6), node("postcode", "10115", 7, 12)])

		const result = await createWOFResolver(backend).resolveTree(input, {
			hierarchyCompletion: true,
			defaultCountry: "DE",
		})

		expect(localityRole(result.roots)?.placeID).toBe("wof:911")
	})

	test("Hierarchy completion is ON by default", async () => {
		const backend = new FakeResolverBackend(DUAL_ROLE_PLACES, RELATION)
		const input = tree("Berlin 10115", [node("region", "Berlin", 0, 6), node("postcode", "10115", 7, 12)])
		const result = await createWOFResolver(backend).resolveTree(input, { defaultCountry: "DE" })
		expect(localityRole(result.roots)?.placeID).toBe("wof:911")
	})

	test("HierarchyCompletion: false opts out of the default", async () => {
		const backend = new FakeResolverBackend(DUAL_ROLE_PLACES, RELATION)
		const input = tree("Berlin 10115", [node("region", "Berlin", 0, 6), node("postcode", "10115", 7, 12)])

		const result = await createWOFResolver(backend).resolveTree(input, {
			hierarchyCompletion: false,
			defaultCountry: "DE",
		})

		expect(localityRole(result.roots)).toBeUndefined()
	})

	test("A backend without the relation no-ops (default-on is safe)", async () => {
		const backend = new FakeResolverBackend(DUAL_ROLE_PLACES)
		const input = tree("Berlin 10115", [node("region", "Berlin", 0, 6), node("postcode", "10115", 7, 12)])
		const result = await createWOFResolver(backend).resolveTree(input, { defaultCountry: "DE" })
		expect(localityRole(result.roots)).toBeUndefined()
	})

	test("Hierarchy completion does nothing for a region absent from the relation", async () => {
		const backend = new FakeResolverBackend(DUAL_ROLE_PLACES, RELATION)
		const input = tree("Brandenburg 14770", [node("region", "Brandenburg", 0, 11), node("postcode", "14770", 12, 17)])

		const result = await createWOFResolver(backend).resolveTree(input, {
			hierarchyCompletion: true,
			defaultCountry: "DE",
		})

		expect(localityRole(result.roots)).toBeUndefined()
	})

	test("Hierarchy completion abstains when candidates tie on population AND distance", async () => {
		const twin = (id: number): CoincidentLocality => ({
			id,
			name: "Berlin",
			placetype: "locality",
			country: "DE",
			lat: 52.52,
			lon: 13.4,
			score: 0,
			relationshipType: "city-state",
			population: 1000,
			distanceKm: 5,
		})

		const backend = new FakeResolverBackend(DUAL_ROLE_PLACES, new Map([[910, [twin(911), twin(912)]]]))
		const input = tree("Berlin 10115", [node("region", "Berlin", 0, 6), node("postcode", "10115", 7, 12)])

		const result = await createWOFResolver(backend).resolveTree(input, {
			hierarchyCompletion: true,
			defaultCountry: "DE",
		})

		expect(localityRole(result.roots)).toBeUndefined()
	})

	test("Hierarchy completion picks the most populous when an admin has several", async () => {
		const small: CoincidentLocality = {
			id: 912,
			name: "Berlin",
			placetype: "locality",
			country: "DE",
			lat: 52.5,
			lon: 13.4,
			score: 0,
			relationshipType: "capital-seat",
			population: 0,
			distanceKm: 1,
		}

		const big: CoincidentLocality = {
			id: 911,
			name: "Berlin",
			placetype: "locality",
			country: "DE",
			lat: 52.52,
			lon: 13.4,
			score: 0,
			relationshipType: "capital-seat",
			population: 3_600_000,
			distanceKm: 40,
		}

		const backend = new FakeResolverBackend(DUAL_ROLE_PLACES, new Map([[910, [small, big]]]))
		const input = tree("Berlin 10115", [node("region", "Berlin", 0, 6), node("postcode", "10115", 7, 12)])

		const result = await createWOFResolver(backend).resolveTree(input, {
			hierarchyCompletion: true,
			defaultCountry: "DE",
		})

		expect(localityRole(result.roots)?.placeID).toBe("wof:911")
	})

	test("Hierarchy completion never adds a role when the parser already emitted a locality", async () => {
		const backend = new FakeResolverBackend(DUAL_ROLE_PLACES, RELATION)
		const input = tree("Some Town, Berlin", [node("locality", "Some Town", 0, 9), node("region", "Berlin", 11, 17)])

		const result = await createWOFResolver(backend).resolveTree(input, {
			hierarchyCompletion: true,
			defaultCountry: "DE",
		})

		expect(result.roots.filter((r) => r.tag === "locality")).toHaveLength(1)
		expect(localityRole(result.roots)).toBeUndefined()
	})

	const LINEAGE = new Map<number, Ancestor[]>([
		[
			101_727_113,
			[
				{ id: 85_688_541, placetype: "region", name: "Illinois" },
				{ id: 85_633_147, placetype: "country", name: "United States" },
			],
		],
	])

	test("IncludeAncestors stamps the lineage onto a resolved node", async () => {
		const backend = new FakeResolverBackend(FIXTURE_PLACES, undefined, LINEAGE)

		const input = tree("Illinois, Springfield", [
			node("region", "Illinois", 0, 8, [node("locality", "Springfield", 10, 21)]),
		])

		const result = await createWOFResolver(backend).resolveTree(input, { includeAncestors: true })
		const locality = result.roots[0]?.children[0]
		expect(locality?.placeID).toBe("wof:101727113")

		expect(locality?.metadata?.["ancestors"]).toEqual([
			{ id: 85_688_541, placetype: "region", name: "Illinois" },
			{ id: 85_633_147, placetype: "country", name: "United States" },
		])
	})

	test("IncludeAncestors is OFF by default — no ancestors metadata", async () => {
		const backend = new FakeResolverBackend(FIXTURE_PLACES, undefined, LINEAGE)

		const input = tree("Illinois, Springfield", [
			node("region", "Illinois", 0, 8, [node("locality", "Springfield", 10, 21)]),
		])

		const result = await createWOFResolver(backend).resolveTree(input)
		expect(result.roots[0]?.children[0]?.metadata?.["ancestors"]).toBeUndefined()
	})
})

describe("ResolveTree — interpolation tier", () => {
	const fakeInterp: InterpolationLookup = {
		find: ({ street, number }) =>
			street.toLowerCase().includes("main") && number === "42"
				? {
						lat: 44.1,
						lon: -72.5,
						interpolated: true,
						method: "tiger_range",
						parityMatched: true,
						bracket: "both",
						uncertaintyM: 35,
						source: "tiger:edges",
						release: "TIGER2023",
					}
				: null,
	}

	const addrTree = () =>
		tree("42 Main St 05601", [
			node("house_number", "42", 0, 2),
			node("street", "Main St", 3, 10),
			node("postcode", "05601", 11, 16),
		])

	test("stamps the interpolated point onto the street node on a hit", async () => {
		const resolver = createWOFResolver(new FakeResolverBackend(FIXTURE_PLACES))
		const result = await resolver.resolveTree(addrTree(), { interpolation: fakeInterp })
		const street = result.roots.find((n) => n.tag === "street")

		expect(street?.metadata).toMatchObject({
			resolution_tier: "interpolated",
			uncertainty_m: 35,
			interpolation_method: "tiger_range",
			parity_matched: true,
			interpolation_bracket: "both",
			interpolated_point: { lat: 44.1, lon: -72.5, source: "tiger:edges", release: "TIGER2023" },
		})

		expect(street?.metadata?.["address_point"]).toBeUndefined()
	})

	test("byte-stable when the flag is absent", async () => {
		const resolver = createWOFResolver(new FakeResolverBackend(FIXTURE_PLACES))
		const withFlagOff = await resolver.resolveTree(addrTree())
		const street = withFlagOff.roots.find((n) => n.tag === "street")
		expect(street?.metadata?.["resolution_tier"]).toBeUndefined()
		expect(street?.metadata?.["interpolated_point"]).toBeUndefined()
	})

	test("exact address-point tier wins — interpolation never overrides a situs point", async () => {
		const resolver = createWOFResolver(new FakeResolverBackend(FIXTURE_PLACES))

		const exact = {
			find: () => ({ lat: 44.2, lon: -72.6, source: "overture:NAD", release: "2026-05-20.0" }),
		}

		const result = await resolver.resolveTree(addrTree(), { addressPoints: exact, interpolation: fakeInterp })
		const street = result.roots.find((n) => n.tag === "street")
		expect(street?.metadata?.["resolution_tier"]).toBe("address_point")
		expect(street?.metadata?.["address_point"]).toMatchObject({ lat: 44.2, lon: -72.6 })

		expect(street?.metadata?.["interpolated_point"]).toBeUndefined()
	})

	test("retries an exact address point after span-rescore recovers its locality", async () => {
		const backend = new FakeResolverBackend([
			{
				id: 1,
				name: "Thames",
				placetype: "locality",
				country: "NZ",
				lat: -37.1368,
				lon: 175.6056,
				score: 9,
				exactMatch: true,
			},
		])

		const calls: Parameters<AddressPointLookup["find"]>[0][] = []

		const exact: AddressPointLookup = {
			find: (query) => {
				calls.push(query)

				return query.locality === "Thames"
					? { lat: -37.137364, lon: 175.541779, source: "openstreetmap:nz", release: "2026-08-06" }
					: null
			},
		}

		const input = tree("620B Pollen Street, Thames", [
			node("street", "Pollen", 5, 11, [node("house_number", "620B", 0, 4), node("street_suffix", "Street", 12, 18)]),
			node("region", "Thames", 20, 26),
		])

		const result = await createWOFResolver(backend).resolveTree(input, {
			addressPoints: exact,
			defaultCountry: "NZ",
		})

		const street = result.roots.find((n) => n.tag === "street")
		const locality = result.roots.find((n) => n.tag === "locality")

		expect(calls).toHaveLength(2)
		expect(calls[0]).toMatchObject({ street: "Pollen Street", number: "620B", locality: undefined })
		expect(calls[1]).toMatchObject({ street: "Pollen Street", number: "620B", locality: "Thames" })
		expect(locality?.metadata?.["span_rescore"]).toBe(true)

		expect(street?.metadata).toMatchObject({
			resolution_tier: "address_point",
			address_point: { lat: -37.137364, lon: 175.541779 },
		})
	})

	test("Miss → no stamp, admin untouched", async () => {
		const resolver = createWOFResolver(new FakeResolverBackend(FIXTURE_PLACES))

		const missTree = tree("999 Main St 05601", [
			node("house_number", "999", 0, 3),
			node("street", "Main St", 4, 11),
			node("postcode", "05601", 12, 17),
		])

		const result = await resolver.resolveTree(missTree, { interpolation: fakeInterp })
		const street = result.roots.find((n) => n.tag === "street")
		expect(street?.metadata?.["resolution_tier"]).toBeUndefined()
	})

	test("Reassembles the full street (prefix+name+suffix) for the lookup query ( coverage fix)", async () => {
		let queried: string | undefined

		const recorder: InterpolationLookup = {
			find: ({ street }) => {
				queried = street

				return null
			},
		}

		const nested = tree("344 East Sheldon Rd 05450", [
			node("street", "Sheldon", 8, 15, [
				node("house_number", "344", 0, 3),
				node("street_prefix", "East", 4, 8),
				node("street_suffix", "Rd", 16, 18),
				node("postcode", "05450", 19, 24),
			]),
		])

		const resolver = createWOFResolver(new FakeResolverBackend(FIXTURE_PLACES))
		await resolver.resolveTree(nested, { interpolation: recorder })
		expect(queried).toBe("East Sheldon Rd")
	})

	test("Folds a directional quadrant mis-tagged `unit` into the street key ( admin-tail)", async () => {
		let queried: string | undefined

		const recorder: InterpolationLookup = {
			find: ({ street }) => {
				queried = street

				return null
			},
		}

		const dirTree = tree("1532 Taylor Street Ne 20018", [
			node("house_number", "1532", 0, 4),
			node("street", "Taylor Street", 5, 18),
			node("unit", "Ne", 19, 21),
			node("postcode", "20018", 22, 27),
		])

		const resolver = createWOFResolver(new FakeResolverBackend(FIXTURE_PLACES))
		await resolver.resolveTree(dirTree, { interpolation: recorder })
		expect(queried).toBe("Taylor Street Ne")
	})

	test("a non-directional `unit` is NOT folded into the street key (byte-stable)", async () => {
		let queried: string | undefined

		const recorder: InterpolationLookup = {
			find: ({ street }) => {
				queried = street

				return null
			},
		}

		const aptTree = tree("1532 Taylor Street Apt 4 20018", [
			node("house_number", "1532", 0, 4),
			node("street", "Taylor Street", 5, 18),
			node("unit", "Apt 4", 19, 24),
			node("postcode", "20018", 25, 30),
		])

		const resolver = createWOFResolver(new FakeResolverBackend(FIXTURE_PLACES))
		await resolver.resolveTree(aptTree, { interpolation: recorder })
		expect(queried).toBe("Taylor Street")
	})

	test("No house_number → tier never fires", async () => {
		let called = false

		const spy: InterpolationLookup = {
			find: (q) => {
				called = true

				return fakeInterp.find(q)
			},
		}

		const resolver = createWOFResolver(new FakeResolverBackend(FIXTURE_PLACES))
		const noHn = tree("Main St", [node("street", "Main St", 0, 7)])
		await resolver.resolveTree(noHn, { interpolation: spy })
		expect(called).toBe(false)
	})

	test("Artifact-carried radiusCalibration is byte-identical to the caller-supplied factor", async () => {
		const resolver = createWOFResolver(new FakeResolverBackend(FIXTURE_PLACES))
		const artifactInterp: InterpolationLookup = { find: fakeInterp.find, radiusCalibration: 1.7 }

		const viaCaller = await resolver.resolveTree(addrTree(), {
			interpolation: fakeInterp,
			interpolationRadiusCalibration: 1.7,
		})

		const viaArtifact = await resolver.resolveTree(addrTree(), { interpolation: artifactInterp })

		expect(stringifyJSON(viaArtifact)).toBe(stringifyJSON(viaCaller))
		const street = viaArtifact.roots.find((n) => n.tag === "street")

		expect(street?.metadata).toMatchObject({
			uncertainty_m: Math.round(35 * 1.7),
			uncertainty_raw_m: 35,
			uncertainty_calibration: 1.7,
		})
	})

	test("an explicit caller factor overrides the artifact's (@internal instrument override)", async () => {
		const resolver = createWOFResolver(new FakeResolverBackend(FIXTURE_PLACES))
		const artifactInterp: InterpolationLookup = { find: fakeInterp.find, radiusCalibration: 1.7 }

		const result = await resolver.resolveTree(addrTree(), {
			interpolation: artifactInterp,
			interpolationRadiusCalibration: 2,
		})

		const street = result.roots.find((n) => n.tag === "street")
		expect(street?.metadata?.["uncertainty_calibration"]).toBe(2)
		expect(street?.metadata?.["uncertainty_m"]).toBe(70)
	})

	test("artifact-silent + caller-silent stays raw (the shipped-fleet path, byte-stable)", async () => {
		const resolver = createWOFResolver(new FakeResolverBackend(FIXTURE_PLACES))
		const result = await resolver.resolveTree(addrTree(), { interpolation: fakeInterp })
		const street = result.roots.find((n) => n.tag === "street")
		expect(street?.metadata?.["uncertainty_m"]).toBe(35)
		expect(street?.metadata?.["uncertainty_raw_m"]).toBeUndefined()
		expect(street?.metadata?.["uncertainty_calibration"]).toBeUndefined()
	})
})

function fakeStreetCentroids(
	entries: Array<{ street: string; commune: string; lat: number; lon: number }>,
	onCall?: () => void
): StreetCentroidLookup {
	const key = (s: string, c: string) =>
		`${s
			.toLowerCase()
			.replaceAll(/['’]/g, "")
			.replaceAll("-", " ")
			.replaceAll(/\s+/g, " ")
			.trim()}|${c.toLowerCase().trim()}`

	const map = new Map(entries.map((e) => [key(e.street, e.commune), e]))

	return {
		find: (q) => {
			onCall?.()
			const commune = q.locality ?? q.postcode ?? ""
			const e = map.get(key(q.street, commune))

			return e ? { lat: e.lat, lon: e.lon, uncertaintyM: 120, source: "ban:fr", release: "2026-05-18" } : null
		},
	}
}

const frProvider = (lookup: StreetCentroidLookup) => (country: string) => (country === "fr" ? lookup : undefined)

function streetTier(t: AddressTree): AddressNode | undefined {
	for (const n of walkNodes(t.roots)) {
		if (n.tag === "street" && n.metadata?.["resolution_tier"] === "street") return n
	}

	return undefined
}

describe("ResolveTree — street-centroid tier", () => {
	test("recovers a thoroughfare the model mis-parsed as a locality (via the FR country hint)", async () => {
		const lookup = fakeStreetCentroids([{ street: "place bellecour", commune: "Lyon", lat: 45.7576, lon: 4.8317 }])
		const resolver = createWOFResolver(new FakeResolverBackend(FIXTURE_PLACES))

		const input = tree("Place Bellecour, Lyon", [
			node("locality", "Place Bellecour", 0, 15),
			node("region", "Lyon", 17, 21),
		])

		const out = await resolver.resolveTree(input, { streetCentroids: frProvider(lookup), streetCountryHints: ["fr"] })
		const street = streetTier(out)
		expect(street).toBeDefined()
		expect(street!.metadata!["street_centroid"]).toMatchObject({ lat: 45.7576, lon: 4.8317, source: "ban:fr" })
		expect(street!.metadata!["uncertainty_m"]).toBe(120)
	})

	test("recovers the commune from the raw comma-split when the parse dropped it", async () => {
		const lookup = fakeStreetCentroids([
			{ street: "rue sainte catherine", commune: "Bordeaux", lat: 44.8364, lon: -0.5736 },
		])

		const resolver = createWOFResolver(new FakeResolverBackend(FIXTURE_PLACES))

		const input = tree("Rue Sainte-Catherine, Bordeaux", [
			node("locality", "e", 0, 1),
			node("street", "Rue Sainte-Catherine", 0, 20),
		])

		const out = await resolver.resolveTree(input, { streetCentroids: frProvider(lookup), streetCountryHints: ["fr"] })
		const street = streetTier(out)
		expect(street?.metadata?.["street_centroid"]).toMatchObject({ lat: 44.8364, lon: -0.5736 })
	})

	test("Unions the RESOLVED-tree country when no hint pins it (placer mis-route recovery)", async () => {
		const places: ResolvedPlace[] = [
			{ id: 1, name: "Bordeaux", placetype: "locality", country: "FR", lat: 44.84, lon: -0.58, score: 9 },
		]

		const lookup = fakeStreetCentroids([
			{ street: "cours de lintendance", commune: "Bordeaux", lat: 44.8419, lon: -0.5772 },
		])

		const resolver = createWOFResolver(new FakeResolverBackend(places))

		const input = tree("Cours de l'Intendance, Bordeaux", [
			node("locality", "Cours de l'Intendance", 0, 21),
			node("locality", "Bordeaux", 23, 31),
		])

		const out = await resolver.resolveTree(input, { streetCentroids: frProvider(lookup) })
		expect(streetTier(out)?.metadata?.["street_centroid"]).toMatchObject({ lat: 44.8419, lon: -0.5772 })
	})

	test(": a span-rescored locality that contradicts the register commune is dropped ('Rue' ≠ 'Bordeaux')", async () => {
		const lookup = fakeStreetCentroids([
			{ street: "rue sainte catherine", commune: "Bordeaux", lat: 44.8364, lon: -0.5736 },
		])

		const resolver = createWOFResolver(new FakeResolverBackend(FIXTURE_PLACES))

		const input = tree("Rue Sainte-Catherine, Bordeaux", [
			node("region", "Bordeaux", 22, 30, [
				node("street", "Sainte-Catherine", 4, 20, [node("street_prefix", "Rue", 0, 3)]),
			]),
			{
				tag: "locality",
				value: "Rue",
				start: 0,
				end: 3,
				confidence: 0.5,
				children: [],
				placeID: "wof:404374855",
				lat: 50.2785,
				lon: 1.6651,
				metadata: { resolver_name: "Rue", resolver_country: "FR", span_rescore: true },
			},
		])

		const out = await resolver.resolveTree(input, { streetCentroids: frProvider(lookup), streetCountryHints: ["fr"] })
		const street = streetTier(out)
		expect(street?.metadata?.["street_centroid"]).toMatchObject({ lat: 44.8364, lon: -0.5736 })
		expect(street?.metadata?.["street_locality"]).toBe("Bordeaux")

		const localities = out.roots.filter((n) => n.tag === "locality")
		expect(localities).toHaveLength(0)
	})

	test(": a span-rescored locality that MATCHES the register commune is kept", async () => {
		const lookup = fakeStreetCentroids([
			{ street: "rue sainte catherine", commune: "Bordeaux", lat: 44.8364, lon: -0.5736 },
		])

		const resolver = createWOFResolver(new FakeResolverBackend(FIXTURE_PLACES))

		const input = tree("Rue Sainte-Catherine, Bordeaux", [
			node("street", "Rue Sainte-Catherine", 0, 20),
			{
				tag: "locality",
				value: "bordeaux",
				start: 22,
				end: 30,
				confidence: 0.5,
				children: [],
				placeID: "wof:117496",
				lat: 44.84,
				lon: -0.58,
				metadata: { resolver_name: "Bordeaux", resolver_country: "FR", span_rescore: true },
			},
		])

		const out = await resolver.resolveTree(input, { streetCentroids: frProvider(lookup), streetCountryHints: ["fr"] })
		const localities = out.roots.filter((n) => n.tag === "locality")
		expect(localities).toHaveLength(1)
	})

	test(": the register-commune fold is diacritic-insensitive ('Sète' ≡ 'Sete')", async () => {
		const lookup = fakeStreetCentroids([
			{ street: "allee pierre barthas", commune: "Sete", lat: 43.403651, lon: 3.670243 },
		])

		const resolver = createWOFResolver(new FakeResolverBackend(FIXTURE_PLACES))

		const input = tree("Allee Pierre Barthas, Sete", [
			node("street", "Allee Pierre Barthas", 0, 20),
			{
				tag: "locality",
				value: "Barthas",
				start: 13,
				end: 20,
				confidence: 0.5,
				children: [],
				metadata: { resolver_name: "Sète", resolver_country: "FR", span_rescore: true },
			},
		])

		const out = await resolver.resolveTree(input, { streetCentroids: frProvider(lookup), streetCountryHints: ["fr"] })

		expect(out.roots.filter((n) => n.tag === "locality")).toHaveLength(1)
	})

	test(": a differently-accented fold does not weaken the condition ('Lyon' ≠ 'Sete')", async () => {
		const lookup = fakeStreetCentroids([
			{ street: "allee pierre barthas", commune: "Sete", lat: 43.403651, lon: 3.670243 },
		])

		const resolver = createWOFResolver(new FakeResolverBackend(FIXTURE_PLACES))

		const input = tree("Allee Pierre Barthas, Sete", [
			node("street", "Allee Pierre Barthas", 0, 20),
			{
				tag: "locality",
				value: "Barthas",
				start: 13,
				end: 20,
				confidence: 0.5,
				children: [],
				metadata: { resolver_name: "Lyon", resolver_country: "FR", span_rescore: true },
			},
		])

		const out = await resolver.resolveTree(input, { streetCentroids: frProvider(lookup), streetCountryHints: ["fr"] })

		expect(out.roots.filter((n) => n.tag === "locality")).toHaveLength(0)
	})

	test("never fires when a house number is present (rooftop tiers' domain)", async () => {
		let called = false

		const lookup = fakeStreetCentroids([{ street: "rue de rivoli", commune: "Paris", lat: 1, lon: 2 }], () => {
			called = true
		})

		const resolver = createWOFResolver(new FakeResolverBackend(FIXTURE_PLACES))

		const input = tree("10 Rue de Rivoli, Paris", [
			node("house_number", "10", 0, 2),
			node("street", "Rue de Rivoli", 3, 16),
			node("locality", "Paris", 18, 23),
		])

		const out = await resolver.resolveTree(input, { streetCentroids: frProvider(lookup), streetCountryHints: ["fr"] })
		expect(called).toBe(false)
		expect(streetTier(out)).toBeUndefined()
	})

	test("No matching country → the lookup is never consulted (byte-stable)", async () => {
		let called = false

		const lookup = fakeStreetCentroids([{ street: "place bellecour", commune: "Lyon", lat: 1, lon: 2 }], () => {
			called = true
		})

		const resolver = createWOFResolver(new FakeResolverBackend(FIXTURE_PLACES))

		const input = tree("Main Street, Springfield", [
			node("street", "Main Street", 0, 11),
			node("locality", "Springfield", 13, 24),
		])

		const out = await resolver.resolveTree(input, { streetCentroids: frProvider(lookup), streetCountryHints: ["us"] })
		expect(called).toBe(false)
		expect(streetTier(out)).toBeUndefined()
	})
})
