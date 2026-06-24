/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Unit tests for `resolveTree` — uses an in-memory `FakeResolverBackend` so the test exercises the
 *   walk + decoration semantics without depending on any concrete WOF data.
 */

import { describe, expect, test, vi } from "vitest"

import { decodeAsXml } from "@mailwoman/core/decoder"
import type { AddressNode, AddressTree, ComponentTag } from "@mailwoman/core/decoder"
import { createWofResolver } from "./resolve.js"
import type { Ancestor, CoincidentLocality, InterpolationLookup, ResolvedPlace, ResolverBackend } from "@mailwoman/core/resolver"
import { expandPlacetypeFilter } from "@mailwoman/core/resolver"

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
		const requested = Array.isArray(query.placetype) ? query.placetype : query.placetype ? [query.placetype] : null
		// Mirror the concrete backends (lookup.ts / wasm): expand the placetype filter through the
		// shared PLACETYPE_FILTER_GROUPS so a `region` query also reaches `macroregion`, etc. (#718).
		const types = expandPlacetypeFilter(requested)
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

	test("#194 hardCountry: a confident placer country is a HARD filter, winning over a higher-scored foreign namesake", async () => {
		// Two same-name localities; the foreign one scores higher (the population-first collision #743 is about).
		const places: ResolvedPlace[] = [
			{ id: 1, name: "Pori", placetype: "locality", country: "FI", lat: 61.48, lon: 21.79, score: 8 },
			{ id: 2, name: "Pori", placetype: "locality", country: "US", lat: 40.0, lon: -90.0, score: 9 },
		]
		const backend = new FakeResolverBackend(places)
		const resolver = createWofResolver(backend)

		const input = tree("Pori", [node("locality", "Pori", 0, 4)])
		const result = await resolver.resolveTree(input, { hardCountry: "FI" })

		// The FI Pori wins despite the US one's higher score — the hard country filter excludes it.
		expect(result.roots[0]).toMatchObject({ placeId: "wof:1", lat: 61.48 })
		expect(backend.calls).toHaveLength(1)
		expect(backend.calls[0]).toMatchObject({ country: "FI" })
	})

	test("#194 hardCountry miss → node left UNRESOLVED, with NO global retry (the in-region-or-unresolved contract)", async () => {
		// The locality exists only in FR; a hardCountry of FI must NOT fall back to it globally.
		const places: ResolvedPlace[] = [
			{ id: 3, name: "Lyon", placetype: "locality", country: "FR", lat: 45.76, lon: 4.84, score: 9 },
		]
		const backend = new FakeResolverBackend(places)
		const resolver = createWofResolver(backend)

		const input = tree("Lyon", [node("locality", "Lyon", 0, 4, [], "neural", "v1")])
		const result = await resolver.resolveTree(input, { hardCountry: "FI" })

		// Unresolved — the classifier attribution survives, no coordinate, no global fallback to the FR Lyon.
		expect(result.roots[0]?.placeId).toBeUndefined()
		expect(result.roots[0]?.lat).toBeUndefined()
		expect(result.roots[0]?.source).toBe("neural")
		// Exactly one lookup, and it carried the FI filter — there is no second, country-less retry.
		expect(backend.calls).toHaveLength(1)
		expect(backend.calls.every((c) => c.country === "FI")).toBe(true)
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

	test("anchor posterior re-ranks REGION candidates by country (#369), off by default", async () => {
		// The region analogue of the locality re-rank — the collision class #447's over-fetch fix
		// couldn't reach. A bare region abbreviation is shared across countries ("VT" is both
		// Vermont and Viterbo; "ME" both Maine and Messina); modeled here as two same-named regions so
		// the fake backend's name-substring match returns both. The non-US region scores higher on
		// name/BM25, so without a signal the wrong country wins — and because resolveTree resolves region
		// FIRST and inherits its country down, that poisons the locality too. The postcode posterior
		// breaks the tie at the region.
		const regions: ResolvedPlace[] = [
			{ id: 1, name: "Vermontia", placetype: "region", country: "IT", lat: 42.4, lon: 12.1, score: 8 },
			{ id: 2, name: "Vermontia", placetype: "region", country: "US", lat: 44.0, lon: -72.7, score: 7 },
		]
		const input = tree("Vermontia", [node("region", "Vermontia", 0, 9)])

		// Default (no posterior): the higher-scored IT region wins — byte-stable.
		const off = await createWofResolver(new FakeResolverBackend(regions)).resolveTree(input)
		expect(off.roots[0]!.placeId).toBe("wof:1")

		// With a US country posterior, the +weight*posterior boost pulls the US region to the top.
		const on = await createWofResolver(new FakeResolverBackend(regions)).resolveTree(input, {
			anchorPosterior: { US: 1.0 },
		})
		expect(on.roots[0]!.placeId).toBe("wof:2")
		expect((on.roots[0]!.alternatives as ResolvedPlace[])[0]!.id).toBe(1) // displaced IT survives
	})

	test("anchor posterior keeps the EXACT match within the pinned country (#369) — tier-safe", async () => {
		// The "ME → Maine, not the more-populous Missouri" guard. Three regions all match the query.
		// With a confident US posterior the US EXACT match (Maineland) must win over (a) a higher-SCORE
		// US PARTIAL match (Missouriland — a plain additive boost would promote it, dropping the tier)
		// and (b) a foreign EXACT match (Messinaland — the posterior breaks that tie WITHIN the exact
		// tier). `exactMatch` is the backend-supplied tier flag (see ResolvedPlace.exactMatch).
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
		const on = await createWofResolver(new FakeResolverBackend(regions)).resolveTree(input, {
			anchorPosterior: { US: 1.0 },
		})
		expect(on.roots[0]!.placeId).toBe("wof:1") // US exact wins: tier primary, then US posterior
	})

	// Macro-tier equivalence groups + fallback observability (#718). WOF models some countries'
	// top-level civil division as `macroregion` (Italian regions; the post-2016 French régions) rather
	// than `region`; likewise `macrocounty` above `county` (FR/DE/GB). The region/county placetype
	// filter now expands through PLACETYPE_FILTER_GROUPS to reach them, but the EXACT type is still
	// preferred, and a macro-only resolution is annotated `resolution_quality: "fallback"`.
	test("region span resolves to a macroregion fallback when no exact region exists (#718)", async () => {
		// Only a macroregion matches "Veneto" — the region-only filter would have returned nothing.
		const places: ResolvedPlace[] = [
			{ id: 404227501, name: "Veneto", placetype: "macroregion", country: "IT", lat: 45.65, lon: 11.86, score: 9 },
		]
		const input = tree("Veneto", [node("region", "Veneto", 0, 6)])
		const out = await createWofResolver(new FakeResolverBackend(places)).resolveTree(input, { defaultCountry: "IT" })
		const r = out.roots[0]!
		expect(r.placeId).toBe("wof:404227501")
		expect(r.sourceId).toBe("macroregion:404227501")
		expect(r.metadata?.["resolution_quality"]).toBe("fallback")
	})

	test("exact region is preferred over a same-name macroregion — no fallback annotation (#718)", async () => {
		// Both an exact region and a macroregion namesake match; the real region must win and carry no
		// fallback marker, even when the macroregion scores higher (the exact-type partition is primary).
		const places: ResolvedPlace[] = [
			{ id: 1, name: "Foo", placetype: "macroregion", country: "IT", lat: 45, lon: 11, score: 9 },
			{ id: 2, name: "Foo", placetype: "region", country: "IT", lat: 46, lon: 12, score: 7 },
		]
		const input = tree("Foo", [node("region", "Foo", 0, 3)])
		const out = await createWofResolver(new FakeResolverBackend(places)).resolveTree(input, { defaultCountry: "IT" })
		const r = out.roots[0]!
		expect(r.sourceId).toBe("region:2") // exact region wins despite lower score
		expect(r.metadata?.["resolution_quality"]).toBeUndefined()
		// The displaced macroregion survives as an alternative.
		expect((r.alternatives as ResolvedPlace[])[0]!.id).toBe(1)
	})

	test("county/subregion span resolves to a macrocounty fallback (#718)", async () => {
		// `subregion` maps to `county` via DEFAULT_PLACETYPE_MAP; a DE Regierungsbezirk is a macrocounty.
		const places: ResolvedPlace[] = [
			{ id: 404227567, name: "Oberbayern", placetype: "macrocounty", country: "DE", lat: 48, lon: 11.5, score: 8 },
		]
		const input = tree("Oberbayern", [node("subregion", "Oberbayern", 0, 10)])
		const out = await createWofResolver(new FakeResolverBackend(places)).resolveTree(input, { defaultCountry: "DE" })
		const r = out.roots[0]!
		expect(r.sourceId).toBe("macrocounty:404227567")
		expect(r.metadata?.["resolution_quality"]).toBe("fallback")
	})

	test("borough/localadmin under a locality query are NOT fallbacks (#718 scope guard)", async () => {
		// The locality equivalence group's borough/localadmin are genuine peers (Brooklyn-the-borough),
		// NOT macro fallbacks — they must resolve normally with no resolution_quality annotation.
		const places: ResolvedPlace[] = [
			{ id: 421205765, name: "Brooklyn", placetype: "borough", country: "US", lat: 40.65, lon: -73.95, score: 8 },
		]
		const input = tree("Brooklyn", [node("locality", "Brooklyn", 0, 8)])
		const out = await createWofResolver(new FakeResolverBackend(places)).resolveTree(input, { defaultCountry: "US" })
		const r = out.roots[0]!
		expect(r.sourceId).toBe("borough:421205765")
		expect(r.metadata?.["resolution_quality"]).toBeUndefined()
	})

	// Dual-role hierarchy completion (#405/#415). In `…, Berlin, Berlin <PC>` the parser drops the
	// locality (city == region), leaving a region but no locality. Completion records the dropped
	// locality as a `locality` INTERPRETATION on the resolved region node (one node, one span, two
	// roles — no synthesized sibling), from the backend's precomputed coincident-roles relation (#403).
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
	const RELATION = new Map<number, CoincidentLocality[]>([[910, [berlinLocality]]])

	// The completed `locality` role, read off the region node's interpretations (where #415 puts it).
	const localityRole = (roots: AddressNode[]): Interpretation | undefined =>
		(roots.find((r) => r.tag === "region")?.interpretations as Interpretation[] | undefined)?.find(
			(i) => i.tag === "locality"
		)

	test("completion records the dropped locality as an interpretation on the region node (#415)", async () => {
		const backend = new FakeResolverBackend(DUAL_ROLE_PLACES, RELATION)
		const input = tree("Berlin 10115", [node("region", "Berlin", 0, 6), node("postcode", "10115", 7, 12)])
		const result = await createWofResolver(backend).resolveTree(input, {
			hierarchyCompletion: true,
			defaultCountry: "DE",
		})

		// No synthesized locality NODE — the role rides on the region node.
		expect(result.roots.find((r) => r.tag === "locality")).toBeUndefined()
		expect(localityRole(result.roots)).toMatchObject({
			tag: "locality",
			placeId: "wof:911",
			lat: 52.52,
			lon: 13.4,
			metadata: { relationship_type: "city-state", resolver_completed: true },
		})
	})

	test("the deprecated cityStateFallback alias still drives completion (#415)", async () => {
		const backend = new FakeResolverBackend(DUAL_ROLE_PLACES, RELATION)
		const input = tree("Berlin 10115", [node("region", "Berlin", 0, 6), node("postcode", "10115", 7, 12)])
		const result = await createWofResolver(backend).resolveTree(input, {
			cityStateFallback: true,
			defaultCountry: "DE",
		})
		expect(localityRole(result.roots)?.placeId).toBe("wof:911")
	})

	test("hierarchy completion is ON by default (#402)", async () => {
		const backend = new FakeResolverBackend(DUAL_ROLE_PLACES, RELATION)
		const input = tree("Berlin 10115", [node("region", "Berlin", 0, 6), node("postcode", "10115", 7, 12)])
		const result = await createWofResolver(backend).resolveTree(input, { defaultCountry: "DE" })
		expect(localityRole(result.roots)?.placeId).toBe("wof:911")
	})

	test("hierarchyCompletion: false opts out of the default (#402)", async () => {
		const backend = new FakeResolverBackend(DUAL_ROLE_PLACES, RELATION)
		const input = tree("Berlin 10115", [node("region", "Berlin", 0, 6), node("postcode", "10115", 7, 12)])
		const result = await createWofResolver(backend).resolveTree(input, {
			hierarchyCompletion: false,
			defaultCountry: "DE",
		})
		expect(localityRole(result.roots)).toBeUndefined()
	})

	test("a backend without the relation no-ops (default-on is safe) (#402)", async () => {
		const backend = new FakeResolverBackend(DUAL_ROLE_PLACES)
		const input = tree("Berlin 10115", [node("region", "Berlin", 0, 6), node("postcode", "10115", 7, 12)])
		const result = await createWofResolver(backend).resolveTree(input, { defaultCountry: "DE" })
		expect(localityRole(result.roots)).toBeUndefined()
	})

	test("hierarchy completion does nothing for a region absent from the relation (#405)", async () => {
		const backend = new FakeResolverBackend(DUAL_ROLE_PLACES, RELATION)
		const input = tree("Brandenburg 14770", [node("region", "Brandenburg", 0, 11), node("postcode", "14770", 12, 17)])
		const result = await createWofResolver(backend).resolveTree(input, {
			hierarchyCompletion: true,
			defaultCountry: "DE",
		})
		expect(localityRole(result.roots)).toBeUndefined()
	})

	test("hierarchy completion abstains when candidates tie on population AND distance (#405)", async () => {
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
		expect(localityRole(result.roots)).toBeUndefined()
	})

	test("hierarchy completion picks the most populous when an admin has several (#405)", async () => {
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
		expect(localityRole(result.roots)?.placeId).toBe("wof:911")
	})

	test("hierarchy completion never adds a role when the parser already emitted a locality (#405)", async () => {
		const backend = new FakeResolverBackend(DUAL_ROLE_PLACES, RELATION)
		const input = tree("Some Town, Berlin", [node("locality", "Some Town", 0, 9), node("region", "Berlin", 11, 17)])
		const result = await createWofResolver(backend).resolveTree(input, {
			hierarchyCompletion: true,
			defaultCountry: "DE",
		})
		expect(result.roots.filter((r) => r.tag === "locality")).toHaveLength(1)
		expect(localityRole(result.roots)).toBeUndefined()
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

describe("resolveTree — interpolation tier (#483)", () => {
	// A fake interpolation lookup: hits "Main St" #42, with an exact-tier-style AddressPointLookup
	// available for the fall-through test. Mirrors the FakeResolverBackend pattern (no SQLite).
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
		const resolver = createWofResolver(new FakeResolverBackend(FIXTURE_PLACES))
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
		// NEVER the exact key — an estimate must not masquerade as a situs point.
		expect(street?.metadata?.["address_point"]).toBeUndefined()
	})

	test("byte-stable when the flag is absent", async () => {
		const resolver = createWofResolver(new FakeResolverBackend(FIXTURE_PLACES))
		const withFlagOff = await resolver.resolveTree(addrTree())
		const street = withFlagOff.roots.find((n) => n.tag === "street")
		expect(street?.metadata?.["resolution_tier"]).toBeUndefined()
		expect(street?.metadata?.["interpolated_point"]).toBeUndefined()
	})

	test("exact address-point tier wins — interpolation never overrides a situs point", async () => {
		const resolver = createWofResolver(new FakeResolverBackend(FIXTURE_PLACES))
		const exact = {
			find: () => ({ lat: 44.2, lon: -72.6, source: "overture:NAD", release: "2026-05-20.0" }),
		}
		const result = await resolver.resolveTree(addrTree(), { addressPoints: exact, interpolation: fakeInterp })
		const street = result.roots.find((n) => n.tag === "street")
		expect(street?.metadata?.["resolution_tier"]).toBe("address_point")
		expect(street?.metadata?.["address_point"]).toMatchObject({ lat: 44.2, lon: -72.6 })
		// the gate held: no interpolated estimate stamped
		expect(street?.metadata?.["interpolated_point"]).toBeUndefined()
	})

	test("miss → no stamp, admin untouched", async () => {
		const resolver = createWofResolver(new FakeResolverBackend(FIXTURE_PLACES))
		const missTree = tree("999 Main St 05601", [
			node("house_number", "999", 0, 3),
			node("street", "Main St", 4, 11),
			node("postcode", "05601", 12, 17),
		])
		const result = await resolver.resolveTree(missTree, { interpolation: fakeInterp })
		const street = result.roots.find((n) => n.tag === "street")
		expect(street?.metadata?.["resolution_tier"]).toBeUndefined()
	})

	test("reassembles the full street (prefix+name+suffix) for the lookup query (#483 coverage fix)", async () => {
		let queried: string | undefined
		const recorder: InterpolationLookup = {
			find: ({ street }) => {
				queried = street
				return null
			},
		}
		// "344 East Sheldon Rd": parser nests street_prefix/street_suffix UNDER street; street.value is
		// the bare base name. The query must be the FULL reassembled street, ordered by offset.
		const nested = tree("344 East Sheldon Rd 05450", [
			node("street", "Sheldon", 8, 15, [
				node("house_number", "344", 0, 3),
				node("street_prefix", "East", 4, 8),
				node("street_suffix", "Rd", 16, 18),
				node("postcode", "05450", 19, 24),
			]),
		])
		const resolver = createWofResolver(new FakeResolverBackend(FIXTURE_PLACES))
		await resolver.resolveTree(nested, { interpolation: recorder })
		expect(queried).toBe("East Sheldon Rd")
	})

	test("folds a directional quadrant mis-tagged `unit` into the street key (#718 admin-tail)", async () => {
		let queried: string | undefined
		const recorder: InterpolationLookup = {
			find: ({ street }) => {
				queried = street
				return null
			},
		}
		// The model often tags the trailing quadrant of a directional street as `unit` ("Taylor Street
		// NE" → [unit] "NE"), so the bare key misses the shard's "taylor street northeast". The
		// directional unit folds back into the key by span order; the lookup normalizer expands "Ne".
		const dirTree = tree("1532 Taylor Street Ne 20018", [
			node("house_number", "1532", 0, 4),
			node("street", "Taylor Street", 5, 18),
			node("unit", "Ne", 19, 21),
			node("postcode", "20018", 22, 27),
		])
		const resolver = createWofResolver(new FakeResolverBackend(FIXTURE_PLACES))
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
		const resolver = createWofResolver(new FakeResolverBackend(FIXTURE_PLACES))
		await resolver.resolveTree(aptTree, { interpolation: recorder })
		expect(queried).toBe("Taylor Street")
	})

	test("no house_number → tier never fires", async () => {
		let called = false
		const spy: InterpolationLookup = {
			find: (q) => {
				called = true
				return fakeInterp.find(q)
			},
		}
		const resolver = createWofResolver(new FakeResolverBackend(FIXTURE_PLACES))
		const noHn = tree("Main St", [node("street", "Main St", 0, 7)])
		await resolver.resolveTree(noHn, { interpolation: spy })
		expect(called).toBe(false)
	})
})
