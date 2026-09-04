/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Unit tests for the demo's admin resolution (`runCascade`, #861: the shared `resolveTree` over
 *   a candidate-style lookup via `CandidateResolverBackend`) against a stub lookup that mimics the
 *   byte-range candidate table: name/country/bbox/placetype filters, population-first ordering, NO
 *   `parentID` support (the adapter translates parent scopes to country/bbox — that translation is
 *   what these tests exercise, alongside pin extraction and the cross-country postcode check). The
 *   coherence passes themselves are tested in `resolver/admin-coherence.test.ts`; integration
 *   coverage against the real DB lives in `packages/mailwoman/lib/dev-tools/demo-cascade-smoke.run.ts`.
 */

import type { AddressNode, AddressTree } from "@mailwoman/core/decoder/types"
import type { ComponentTag } from "@mailwoman/core/types/component"
import { runCascade } from "@mailwoman/docs/shared/demo-helpers"
import type { MailwomanLookupLike } from "@mailwoman/docs/shared/resources"
import { describe, expect, test, vi } from "vitest"

type FindPlaceQuery = Parameters<MailwomanLookupLike["findPlace"]>[0]

type Hit = Awaited<ReturnType<MailwomanLookupLike["findPlace"]>>[number]

interface StubPlace extends Hit {
	nameKeys?: string[]
}

const AT_BBOX = { minLat: 46.4, maxLat: 49, minLon: 9.5, maxLon: 17.2 }

/**
 * A candidate-table-shaped stub: exact normalized-name match (candidate rows are always `exactMatch`), score-ordered
 * (population-first), honoring country/bbox/placetype filters and IGNORING parentID (the table has none — the adapter
 * must translate).
 */
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

// The real node type. A local structural stand-in compiled only while `runCascade` took a loose
// `{ roots: unknown[] }`; now that it takes an `AddressTree`, a fixture that cannot satisfy one is a
// fixture that does not model what the function is given.
//
// `start`/`end` are required and are not decoration: the resolver reads spans. They are derived from the
// raw string here so a fixture cannot claim an offset the text does not have.
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
	test("locality pin with region context — locality outranks the resolved region", async () => {
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

	test("#822 class: explicit country token re-picks the locality out of the populous namesake", async () => {
		// Population ranking alone picks Vienna, US (higher score). The explicit-country coherence
		// pass must re-pick Vienna, AT — through the adapter, whose country-candidate memo turns the
		// pass's scoped queries into the `country` filter the candidate table can answer.
		const lookup = stubLookup([
			{ id: 10, name: "Vienna", placetype: "locality", country: "US", lat: 38.9, lon: -77.26, score: 9 },
			{ id: 11, name: "Vienna", placetype: "locality", country: "AT", lat: 48.21, lon: 16.37, score: 3, bbox: AT_BBOX },
			{ id: 12, name: "Austria", placetype: "country", country: "AT", lat: 47.6, lon: 14.1, score: 2, bbox: AT_BBOX },
		])

		// The country token is the locality's admin CONTEXT — the parse tree nests it above the
		// locality (same shape the phrase-grouper emits), which is what arms the pass.
		const hits = await runCascade(
			lookup,
			tree("Vienna, Austria", [node("country", "Austria", [node("locality", "Vienna")])]),
			"Vienna, Austria"
		)

		expect(hits[0]?.id).toBe(11)
		expect(hits[0]?.country).toBe("AT")
	})

	test("the locality outpins an AREA-class postcode (the epoch convention, 2026-08-11 convergence)", async () => {
		// A US 5-digit ZIP is coarser than the locality it sits in — Node's ladder pins the locality,
		// and the demo now agrees (the staged-repoint e2e measured the old postcode-first order
		// pinning the SI 6250 area centroid where Node pins Zabiče).
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

	test("a UNIT-GRADE exact postcode hit keeps the top pin (#977/#22 — the GB unit tier)", async () => {
		// `N7 0BT` resolves its own full unit code (~15 addresses) — categorically tighter than the
		// London centroid, so it pins above the locality, same as Node's ladder.
		const lookup = stubLookup([
			// `nameKeys` carries the spaced query surface; `name` stays the gazetteer's canonical unspaced
			// form — the exact pair isUnitGradePostcodeHit compares.
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

	test("cross-country postcode check: a foreign postcode match cannot out-pin the parsed city", async () => {
		// "10115"-class: the postcode string resolves to a DE row, the city is a US locality — the
		// locality wins the pin; the postcode stays in the hit list.
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
