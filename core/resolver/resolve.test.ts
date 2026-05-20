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
import type { ResolvedPlace, ResolverBackend } from "./types.js"

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

	constructor(places: ResolvedPlace[]) {
		this.#places = places
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
