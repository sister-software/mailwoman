import type { ComponentTag } from "@mailwoman/codex/component"
import type { AddressNode, AddressTree } from "@mailwoman/core/decoder/types"
import type { MailwomanLookupLike } from "@mailwoman/resolver-wof-wasm/browser-cascade"
import { runCascade } from "@mailwoman/resolver-wof-wasm/browser-cascade"
import { describe, expect, test, vi } from "vitest"

type FindPlaceQuery = Parameters<MailwomanLookupLike["findPlace"]>[0]

type Hit = Awaited<ReturnType<MailwomanLookupLike["findPlace"]>>[number]

interface StubPlace extends Hit {
	nameKeys?: string[]
}

const AT_BBOX = { minLat: 46.4, maxLat: 49, minLon: 9.5, maxLon: 17.2 }

function stubLookup(places: StubPlace[]): MailwomanLookupLike {
	return {
		findPlace: vi.fn(async (q: FindPlaceQuery) => {
			const text = q.text.toLowerCase().trim()
			const types = q.placetype ? (Array.isArray(q.placetype) ? q.placetype : [q.placetype]) : null

			return places
				.filter((p) => p.name.toLowerCase() === text || p.nameKeys?.includes(text))
				.filter(
					(p) => !types || types.some((t) => t === p.placetype || (t === "locality" && p.placetype === "borough"))
				)
				.filter((p) => !q.country || p.country === q.country)
				.filter(
					(p) =>
						!q.bbox ||
						(p.lat >= q.bbox.minLat && p.lat <= q.bbox.maxLat && p.lon >= q.bbox.minLon && p.lon <= q.bbox.maxLon)
				)
				.map((p) => ({ ...p, exactMatch: p.exactMatch ?? true }))
				.toSorted((a, b) => b.score - a.score)
				.slice(0, q.limit ?? 5)
		}),
	}
}

const node = (tag: ComponentTag, value: string, children: AddressNode[] = []): AddressNode => ({
	tag,
	value,
	start: 0,
	end: value.length,
	confidence: 0.95,
	children,
})

const tree = (raw: string, roots: AddressNode[]): AddressTree => ({ raw, roots })

describe("runCascade (shared resolveTree over the candidate lookup)", () => {
	test("Locality pin with region context — locality outranks the resolved region", async () => {
		const lookup = stubLookup([
			{ id: 1, name: "Springfield", placetype: "locality", country: "US", lat: 39.8, lon: -89.6, score: 5 },
			{
				id: 2,
				name: "Illinois",
				placetype: "region",
				country: "US",
				lat: 40,
				lon: -89,
				score: 4,
				bbox: { minLat: 36.9, maxLat: 42.5, minLon: -91.5, maxLon: -87.5 },
			},
		])

		const hits = await runCascade(
			lookup,
			tree("Springfield, Illinois", [node("region", "Illinois", [node("locality", "Springfield")])]),
			"Springfield, Illinois"
		)

		expect(hits[0]?.id).toBe(1)
		expect(hits.map((h) => h.id)).toContain(2)
	})

	test("Class: explicit country token re-picks the locality out of the populous namesake", async () => {
		const lookup = stubLookup([
			{ id: 10, name: "Vienna", placetype: "locality", country: "US", lat: 38.9, lon: -77.26, score: 9 },
			{ id: 11, name: "Vienna", placetype: "locality", country: "AT", lat: 48.21, lon: 16.37, score: 3, bbox: AT_BBOX },
			{ id: 12, name: "Austria", placetype: "country", country: "AT", lat: 47.6, lon: 14.1, score: 2, bbox: AT_BBOX },
		])

		const hits = await runCascade(
			lookup,
			tree("Vienna, Austria", [node("country", "Austria", [node("locality", "Vienna")])]),
			"Vienna, Austria"
		)

		expect(hits[0]?.id).toBe(11)
		expect(hits[0]?.country).toBe("AT")
	})

	test("The locality outpins an AREA-class postcode (the epoch convention, 2026-08-11 convergence)", async () => {
		const lookup = stubLookup([
			{ id: 20, name: "20500", placetype: "postalcode", country: "US", lat: 38.9, lon: -77.03, score: 1 },
			{ id: 21, name: "Washington", placetype: "locality", country: "US", lat: 38.9, lon: -77.04, score: 8 },
		])

		const hits = await runCascade(
			lookup,
			tree("Washington 20500", [node("locality", "Washington"), node("postcode", "20500")]),
			"Washington 20500"
		)

		expect(hits[0]?.placetype).toBe("locality")
	})

	test("A UNIT-GRADE exact postcode hit keeps the top pin ( — the GB unit tier)", async () => {
		const lookup = stubLookup([
			{
				id: 30,
				name: "N70BT",
				nameKeys: ["n7 0bt"],
				placetype: "postalcode",
				country: "GB",
				lat: 51.55,
				lon: -0.1307,
				score: 1,
			},
			{ id: 31, name: "London", placetype: "locality", country: "GB", lat: 51.5, lon: -0.11, score: 9 },
		])

		const hits = await runCascade(
			lookup,
			tree("N7 0BT, London", [node("locality", "London"), node("postcode", "N7 0BT")]),
			"N7 0BT, London"
		)

		expect(hits[0]?.placetype).toBe("postalcode")
	})

	test("Cross-country postcode check: a foreign postcode match cannot out-pin the parsed city", async () => {
		const lookup = stubLookup([
			{ id: 30, name: "10115", placetype: "postalcode", country: "DE", lat: 52.53, lon: 13.38, score: 2 },
			{ id: 31, name: "New York", placetype: "locality", country: "US", lat: 40.71, lon: -74, score: 9 },
		])

		const hits = await runCascade(
			lookup,
			tree("New York 10115", [node("locality", "New York"), node("postcode", "10115")]),
			"New York 10115"
		)

		expect(hits[0]?.id).toBe(31)
		expect(hits.map((h) => h.id)).toContain(30)
	})

	test("raw-text fallback when nothing in the tree resolves", async () => {
		const lookup = stubLookup([
			{
				id: 40,
				name: "Pier 39",
				placetype: "locality",
				country: "US",
				lat: 37.8,
				lon: -122.4,
				score: 1,
				nameKeys: ["pier 39, san francisco"],
			},
		])

		const hits = await runCascade(lookup, tree("Pier 39, San Francisco", []), "Pier 39, San Francisco")

		expect(hits[0]?.id).toBe(40)
	})

	test("drops (0,0) placeholder hits", async () => {
		const lookup = stubLookup([
			{ id: 50, name: "Nowhere", placetype: "locality", country: "US", lat: 0, lon: 0, score: 9 },
		])

		const hits = await runCascade(lookup, tree("Nowhere", [node("locality", "Nowhere")]), "Nowhere")

		expect(hits).toEqual([])
	})
})
