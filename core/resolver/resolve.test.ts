/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Unit tests for `resolveTree` — uses an in-memory `FakeResolverBackend` so the test exercises the
 *   walk + decoration semantics without depending on any concrete WOF data.
 */

import { describe, expect, test, vi } from "vitest"

import { decodeAsXml } from "../decoder/serialize-xml.js"
import type { AddressNode, AddressTree, ComponentTag } from "../decoder/types.js"
import { createWofResolver } from "./resolve.js"
import type { Ancestor, CoincidentLocality, ResolvedPlace, ResolverBackend } from "./types.js"

function node(
	tag: ComponentTag,
	value: string,
	start: number,
	end: number,
	children: AddressNode[] = [],
	source?: string,
	sourceId?: string
): AddressNode {
	const n: AddressNode = { tag, value, start, end, confidence: 0.9, children }
	if (source) n.source = source
	if (sourceId) n.sourceId = sourceId
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
		const types = Array.isArray(query.placetype) ? query.placetype : query.placetype ? [query.placetype] : null
		return this.#places
			.filter((p) => p.name.toLowerCase().includes(text))
			.filter((p) => !types || types.includes(p.placetype))
			.filter((p) => !query.country || p.country === query.country)
			.filter((p) => query.parentId === undefined || p.parent_id === query.parentId)
			.slice(0, query.limit ?? 5)
	}

	coincidentLocalitiesFor(adminId: number | string): CoincidentLocality[] {
		return this.#coincident.get(Number(adminId)) ?? []
	}

	ancestors(id: number | string): Ancestor[] {
		return this.#ancestors.get(Number(id)) ?? []
	}
}

const FIXTURE_PLACES: ResolvedPlace[] = [
	{ id: 85633147, name: "United States", placetype: "country", country: "US", lat: 39.5, lon: -98.0, score: 10 },
	{ id: 85633723, name: "France", placetype: "country", country: "FR", lat: 46.5, lon: 2.5, score: 10 },
	{
		id: 85688489,
		name: "Texas",
		placetype: "region",
		country: "US",
		parent_id: 85633147,
		lat: 31.0,
		lon: -100.0,
		score: 9,
	},
	{
		id: 85688541,
		name: "Illinois",
		placetype: "region",
		country: "US",
		parent_id: 85633147,
		lat: 40.0,
		lon: -89.0,
		score: 9,
	},
	{
		id: 101715829,
		name: "Paris",
		placetype: "locality",
		country: "US",
		parent_id: 85688489,
		lat: 33.66,
		lon: -95.55,
		score: 8,
	},
	{
		id: 101727113,
		name: "Springfield",
		placetype: "locality",
		country: "US",
		parent_id: 85688541,
		lat: 39.78,
		lon: -89.65,
		score: 8,
	},
	{
		id: 101729437,
		name: "Springfield",
		placetype: "locality",
		country: "US",
		parent_id: 85688543, // Massachusetts — not in this fixture as a region
		lat: 42.1,
		lon: -72.59,
		score: 8,
	},
]

describe("resolveTree", () => {
	test("decorates a matched node with resolver source + sourceId + lat/lon + placeId", async () => {
		const backend = new FakeResolverBackend(FIXTURE_PLACES)
		const resolver = createWofResolver(backend)

		const input = tree("Texas", [node("region", "Texas", 0, 5)])
		const result = await resolver.resolveTree(input)

		expect(result.roots[0]).toMatchObject({
			tag: "region",
			value: "Texas",
			source: "resolver",
			sourceId: "region:85688489",
			lat: 31.0,
			lon: -100.0,
			placeId: "wof:85688489",
		})
	})

	test("preserves classifier attribution into metadata when it gets displaced", async () => {
		const backend = new FakeResolverBackend(FIXTURE_PLACES)
		const resolver = createWofResolver(backend)

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
		const resolver = createWofResolver(backend)

		const input = tree("Nowheresville", [node("locality", "Nowheresville", 0, 13, [], "neural", "v1")])
		const result = await resolver.resolveTree(input)

		expect(result.roots[0]?.source).toBe("neural")
		expect(result.roots[0]?.sourceId).toBe("v1")
		expect(result.roots[0]?.lat).toBeUndefined()
		expect(result.roots[0]?.placeId).toBeUndefined()
		expect(result.roots[0]?.metadata).toBeUndefined()
	})

	test("does NOT mutate the input tree", async () => {
		const backend = new FakeResolverBackend(FIXTURE_PLACES)
		const resolver = createWofResolver(backend)

		const input = tree("Texas", [node("region", "Texas", 0, 5, [], "rule", "whos_on_first")])
		const before = JSON.stringify(input)
		await resolver.resolveTree(input)
		expect(JSON.stringify(input)).toBe(before)
	})

	test("skips nodes whose tag isn't in the placetype map (street / house_number / etc)", async () => {
		const backend = new FakeResolverBackend(FIXTURE_PLACES)
		const resolver = createWofResolver(backend)

		const input = tree("123 Main St", [node("street", "Main St", 4, 11), node("house_number", "123", 0, 3)])
		await resolver.resolveTree(input)
		expect(backend.calls).toHaveLength(0)
	})

	test("inherits parent's country code into child queries", async () => {
		const backend = new FakeResolverBackend(FIXTURE_PLACES)
		const resolver = createWofResolver(backend)

		const input = tree("Texas, Paris", [node("region", "Texas", 0, 5, [node("locality", "Paris", 7, 12)])])
		await resolver.resolveTree(input)

		// Parent (region) query: no country constraint.
		expect(backend.calls[0]).toMatchObject({ text: "Texas", placetype: "region" })
		expect(backend.calls[0]).not.toHaveProperty("country")
		// Child (locality) query: country inherited from the parent's resolution (US).
		expect(backend.calls[1]).toMatchObject({ text: "Paris", placetype: "locality", country: "US" })
	})

	test("inherits parent's id into child queries via parentId", async () => {
		const backend = new FakeResolverBackend(FIXTURE_PLACES)
		const resolver = createWofResolver(backend)

		const input = tree("Illinois, Springfield", [
			node("region", "Illinois", 0, 8, [node("locality", "Springfield", 10, 21)]),
		])
		const result = await resolver.resolveTree(input)

		// The child lookup carries parentId = the resolved Illinois id (85688541).
		expect(backend.calls[1]).toMatchObject({
			text: "Springfield",
			placetype: "locality",
			parentId: 85688541,
		})
		// And the resolved locality is the IL Springfield, not the MA one.
		expect(result.roots[0]?.children[0]?.placeId).toBe("wof:101727113")
	})

	test("respects maxLookups budget", async () => {
		const backend = new FakeResolverBackend(FIXTURE_PLACES)
		const resolver = createWofResolver(backend)

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
		const resolver = createWofResolver(backend)

		const input = tree("Texas", [node("region", "Texas", 0, 5, [], "rule", "whos_on_first")])
		const result = await resolver.resolveTree(input, { minWinningScore: 100 })
		// All fixture scores top out at 10; with a 100 floor, the resolver leaves classifier
		// attribution in place.
		expect(result.roots[0]?.source).toBe("rule")
		expect(result.roots[0]?.sourceId).toBe("whos_on_first")
		expect(result.roots[0]?.placeId).toBeUndefined()
	})

	test("placetypeMap override can disable a default mapping", async () => {
		const backend = new FakeResolverBackend(FIXTURE_PLACES)
		const resolver = createWofResolver(backend)

		const input = tree("Texas", [node("region", "Texas", 0, 5)])
		await resolver.resolveTree(input, { placetypeMap: { country: "country" } }) // omits region

		// With region dropped, no backend call should fire.
		expect(backend.calls).toHaveLength(0)
	})

	test("backend errors are caught and the node falls through unchanged", async () => {
		const backend: ResolverBackend = {
			async findPlace() {
				throw new Error("backend boom")
			},
		}
		const resolver = createWofResolver(backend)

		const input = tree("Texas", [node("region", "Texas", 0, 5, [], "rule", "whos_on_first")])
		const result = await resolver.resolveTree(input)
		expect(result.roots[0]?.source).toBe("rule")
		expect(result.roots[0]?.placeId).toBeUndefined()
	})

	test("empty-value node doesn't issue a lookup", async () => {
		const backend = new FakeResolverBackend(FIXTURE_PLACES)
		const resolver = createWofResolver(backend)

		const input = tree("", [node("region", "  ", 0, 2)])
		await resolver.resolveTree(input)
		expect(backend.calls).toHaveLength(0)
	})

	test("emits lat/lon/place in XML serialization after resolve", async () => {
		const backend = new FakeResolverBackend(FIXTURE_PLACES)
		const resolver = createWofResolver(backend)

		const input = tree("Texas", [node("region", "Texas", 0, 5)])
		const result = await resolver.resolveTree(input)
		const xml = decodeAsXml(result)

		expect(xml).toContain(`src="resolver:region:85688489"`)
		expect(xml).toContain(`lat="31.000000"`)
		expect(xml).toContain(`lon="-100.000000"`)
		expect(xml).toContain(`place="wof:85688489"`)
	})

	test("XML serializer can suppress geo + place via opts", async () => {
		const backend = new FakeResolverBackend(FIXTURE_PLACES)
		const resolver = createWofResolver(backend)

		const input = tree("Texas", [node("region", "Texas", 0, 5)])
		const result = await resolver.resolveTree(input)
		const xml = decodeAsXml(result, { includeGeo: false, includePlace: false })

		expect(xml).not.toContain("lat=")
		expect(xml).not.toContain("lon=")
		expect(xml).not.toContain("place=")
		// `src` stays because includeSrc defaults to true.
		expect(xml).toContain("src=")
	})

	test("backend call site receives candidatesPerLookup as `limit`", async () => {
		const backend = new FakeResolverBackend(FIXTURE_PLACES)
		const findPlaceSpy = vi.spyOn(backend, "findPlace")
		const resolver = createWofResolver(backend)

		const input = tree("Texas", [node("region", "Texas", 0, 5)])
		await resolver.resolveTree(input, { candidatesPerLookup: 3 })
		expect(findPlaceSpy).toHaveBeenCalledWith(expect.objectContaining({ limit: 3 }))
	})
})

describe("resolveTree — alternatives (candidate-list API)", () => {
	const AMBIG_PLACES: ResolvedPlace[] = [
		// Three Springfields: same name, different states. The Springfield-class ambiguity.
		{
			id: 101727113,
			name: "Springfield",
			placetype: "locality",
			country: "US",
			parent_id: 85688541,
			lat: 39.78,
			lon: -89.65,
			score: 8,
		},
		{
			id: 101728010,
			name: "Springfield",
			placetype: "locality",
			country: "US",
			parent_id: 85688547,
			lat: 37.21,
			lon: -93.29,
			score: 7,
		},
		{
			id: 101729887,
			name: "Springfield",
			placetype: "locality",
			country: "US",
			parent_id: 85688549,
			lat: 42.1,
			lon: -72.59,
			score: 6,
		},
	]

	test("surfaces runner-up candidates on resolved node", async () => {
		const backend = new FakeResolverBackend(AMBIG_PLACES)
		const resolver = createWofResolver(backend)

		const input = tree("Springfield", [node("locality", "Springfield", 0, 11)])
		const result = await resolver.resolveTree(input)
		const root = result.roots[0]!

		// Top candidate (IL Springfield, score 8) wins for placeId/lat/lon.
		expect(root.placeId).toBe("wof:101727113")
		expect(root.lat).toBe(39.78)

		// alternatives expose the remaining candidates in rank order.
		expect(root.alternatives).toBeDefined()
		const alts = root.alternatives as ResolvedPlace[]
		expect(alts).toHaveLength(2)
		expect(alts[0]?.id).toBe(101728010) // MO Springfield
		expect(alts[1]?.id).toBe(101729887) // MA Springfield
	})

	test("alternatives is absent (not just empty) when only one candidate", async () => {
		const backend = new FakeResolverBackend([AMBIG_PLACES[0]!])
		const resolver = createWofResolver(backend)

		const input = tree("Springfield", [node("locality", "Springfield", 0, 11)])
		const result = await resolver.resolveTree(input)
		expect(result.roots[0]?.alternatives).toBeUndefined()
	})

	test("alternatives is absent when no candidates resolved", async () => {
		const backend = new FakeResolverBackend([])
		const resolver = createWofResolver(backend)

		const input = tree("Atlantis", [node("locality", "Atlantis", 0, 8)])
		const result = await resolver.resolveTree(input)
		expect(result.roots[0]?.alternatives).toBeUndefined()
		expect(result.roots[0]?.placeId).toBeUndefined()
	})

	test("alternatives respects candidatesPerLookup (top + alternatives = limit)", async () => {
		const backend = new FakeResolverBackend(AMBIG_PLACES)
		const resolver = createWofResolver(backend)

		const input = tree("Springfield", [node("locality", "Springfield", 0, 11)])
		const result = await resolver.resolveTree(input, { candidatesPerLookup: 2 })
		const root = result.roots[0]!

		expect(root.placeId).toBe("wof:101727113") // top
		const alts = root.alternatives as ResolvedPlace[]
		expect(alts).toHaveLength(1) // limit 2 → top + 1 alternative
	})

	test("anchor posterior re-ranks locality candidates by country (#369), off by default", async () => {
		// Two same-named localities; US scores higher on name/BM25, DE is the runner-up.
		const berlins: ResolvedPlace[] = [
			{ id: 1, name: "Berlin", placetype: "locality", country: "US", lat: 44.46, lon: -71.18, score: 8 },
			{ id: 2, name: "Berlin", placetype: "locality", country: "DE", lat: 52.52, lon: 13.4, score: 7 },
		]
		const input = tree("Berlin", [node("locality", "Berlin", 0, 6)])

		// Default (no posterior): the higher-scored US Berlin wins — byte-stable.
		const off = await createWofResolver(new FakeResolverBackend(berlins)).resolveTree(input)
		expect(off.roots[0]!.placeId).toBe("wof:1")

		// With a DE country posterior, the +weight*posterior boost pulls the German Berlin to the top.
		const on = await createWofResolver(new FakeResolverBackend(berlins)).resolveTree(input, {
			anchorPosterior: { DE: 1.0 },
		})
		expect(on.roots[0]!.placeId).toBe("wof:2")
		// The displaced US Berlin survives as the top alternative.
		expect((on.roots[0]!.alternatives as ResolvedPlace[])[0]!.id).toBe(1)
	})

	test("anchor posterior leaves the pick unchanged when it already agrees (#369)", async () => {
		const berlins: ResolvedPlace[] = [
			{ id: 1, name: "Berlin", placetype: "locality", country: "US", lat: 44.46, lon: -71.18, score: 8 },
			{ id: 2, name: "Berlin", placetype: "locality", country: "DE", lat: 52.52, lon: 13.4, score: 7 },
		]
		const input = tree("Berlin", [node("locality", "Berlin", 0, 6)])
		const on = await createWofResolver(new FakeResolverBackend(berlins)).resolveTree(input, {
			anchorPosterior: { US: 1.0 },
		})
		expect(on.roots[0]!.placeId).toBe("wof:1") // US already top, boost keeps it there
	})

	// Dual-role hierarchy completion (#405, generalizes #387). In `…, Berlin, Berlin <PC>` the parser
	// drops the locality (city == region), leaving a region but no locality. Completion synthesizes it
	// from the backend's precomputed coincident-roles relation (#403) — a membership lookup, not a
	// runtime distance check. The places fixture only needs the region (so it resolves); the relation
	// supplies the completion candidate.
	const DUAL_ROLE_PLACES: ResolvedPlace[] = [
		{ id: 900, name: "Germany", placetype: "country", country: "DE", lat: 51.1, lon: 10.4, score: 10 },
		{ id: 910, name: "Berlin", placetype: "region", country: "DE", parent_id: 900, lat: 52.52, lon: 13.4, score: 9 },
		// Brandenburg resolves as a region but is NOT in the relation (not a dual-role place).
		{
			id: 920,
			name: "Brandenburg",
			placetype: "region",
			country: "DE",
			parent_id: 900,
			lat: 52.4,
			lon: 13.0,
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
	// admin_id → coincident localities. Berlin (910) is dual-role; Brandenburg (920) is absent.
	const RELATION = new Map<number, CoincidentLocality[]>([[910, [berlinLocality]]])

	test("hierarchy completion synthesizes the dropped locality from the relation (#405)", async () => {
		const backend = new FakeResolverBackend(DUAL_ROLE_PLACES, RELATION)
		const input = tree("Berlin 10115", [node("region", "Berlin", 0, 6), node("postcode", "10115", 7, 12)])
		const result = await createWofResolver(backend).resolveTree(input, {
			hierarchyCompletion: true,
			defaultCountry: "DE",
		})

		const locality = result.roots.find((r) => r.tag === "locality")
		expect(locality).toBeDefined()
		expect(locality).toMatchObject({
			tag: "locality",
			value: "Berlin",
			source: "resolver",
			placeId: "wof:911",
			lat: 52.52,
			lon: 13.4,
		})
		expect(locality!.metadata).toMatchObject({ resolver_synthesized: true, relationship_type: "city-state" })
	})

	test("the deprecated cityStateFallback alias still drives completion (#405)", async () => {
		const backend = new FakeResolverBackend(DUAL_ROLE_PLACES, RELATION)
		const input = tree("Berlin 10115", [node("region", "Berlin", 0, 6), node("postcode", "10115", 7, 12)])
		const result = await createWofResolver(backend).resolveTree(input, {
			cityStateFallback: true,
			defaultCountry: "DE",
		})
		expect(result.roots.find((r) => r.tag === "locality")?.placeId).toBe("wof:911")
	})

	test("hierarchy completion is OFF by default — byte-stable (#405)", async () => {
		const backend = new FakeResolverBackend(DUAL_ROLE_PLACES, RELATION)
		const input = tree("Berlin 10115", [node("region", "Berlin", 0, 6), node("postcode", "10115", 7, 12)])
		const result = await createWofResolver(backend).resolveTree(input, { defaultCountry: "DE" })
		expect(result.roots.find((r) => r.tag === "locality")).toBeUndefined()
	})

	test("hierarchy completion does nothing for a region absent from the relation (#405)", async () => {
		const backend = new FakeResolverBackend(DUAL_ROLE_PLACES, RELATION)
		// Brandenburg resolves as a region but isn't a dual-role place → the relation has no entry → no completion.
		const input = tree("Brandenburg 14770", [node("region", "Brandenburg", 0, 11), node("postcode", "14770", 12, 17)])
		const result = await createWofResolver(backend).resolveTree(input, {
			hierarchyCompletion: true,
			defaultCountry: "DE",
		})
		expect(result.roots.find((r) => r.tag === "locality")).toBeUndefined()
	})

	test("hierarchy completion abstains when candidates tie on population AND distance (#405)", async () => {
		// Two same-name localities, identical population + distance → genuinely indistinguishable → abstain.
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
		const result = await createWofResolver(backend).resolveTree(input, {
			hierarchyCompletion: true,
			defaultCountry: "DE",
		})
		expect(result.roots.find((r) => r.tag === "locality")).toBeUndefined()
	})

	test("hierarchy completion picks the most populous when an admin has several (#405)", async () => {
		// The principal city (high population) wins even if it sits farther from the region centroid (Niigata).
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
		const result = await createWofResolver(backend).resolveTree(input, {
			hierarchyCompletion: true,
			defaultCountry: "DE",
		})
		expect(result.roots.find((r) => r.tag === "locality")?.placeId).toBe("wof:911")
	})

	test("hierarchy completion never overrides a locality the parser already emitted (#405)", async () => {
		const backend = new FakeResolverBackend(DUAL_ROLE_PLACES, RELATION)
		// A real locality span is present (even if it won't resolve) → the gap-filler must stay quiet.
		const input = tree("Some Town, Berlin", [node("locality", "Some Town", 0, 9), node("region", "Berlin", 11, 17)])
		const result = await createWofResolver(backend).resolveTree(input, {
			hierarchyCompletion: true,
			defaultCountry: "DE",
		})
		const localities = result.roots.filter((r) => r.tag === "locality")
		expect(localities).toHaveLength(1)
		expect(localities[0]!.value).toBe("Some Town")
		expect(localities[0]!.metadata?.["resolver_synthesized"]).toBeUndefined()
	})

	// Ancestor-lineage attachment (#404). Opt-in enrichment: stamp each resolved node's containment
	// chain onto metadata.ancestors. Off by default → byte-stable.
	const LINEAGE = new Map<number, Ancestor[]>([
		[
			101727113,
			[
				{ id: 85688541, placetype: "region", name: "Illinois" },
				{ id: 85633147, placetype: "country", name: "United States" },
			],
		],
	])

	test("includeAncestors stamps the lineage onto a resolved node (#404)", async () => {
		const backend = new FakeResolverBackend(FIXTURE_PLACES, undefined, LINEAGE)
		const input = tree("Illinois, Springfield", [
			node("region", "Illinois", 0, 8, [node("locality", "Springfield", 10, 21)]),
		])
		const result = await createWofResolver(backend).resolveTree(input, { includeAncestors: true })
		const locality = result.roots[0]?.children[0]
		expect(locality?.placeId).toBe("wof:101727113")
		expect(locality?.metadata?.["ancestors"]).toEqual([
			{ id: 85688541, placetype: "region", name: "Illinois" },
			{ id: 85633147, placetype: "country", name: "United States" },
		])
	})

	test("includeAncestors is OFF by default — no ancestors metadata (#404)", async () => {
		const backend = new FakeResolverBackend(FIXTURE_PLACES, undefined, LINEAGE)
		const input = tree("Illinois, Springfield", [
			node("region", "Illinois", 0, 8, [node("locality", "Springfield", 10, 21)]),
		])
		const result = await createWofResolver(backend).resolveTree(input)
		expect(result.roots[0]?.children[0]?.metadata?.["ancestors"]).toBeUndefined()
	})
})
