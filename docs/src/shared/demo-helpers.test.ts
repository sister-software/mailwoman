/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Unit tests for the demo's WOF cascade (`runCascade`) against a stub lookup — the fail-loud
 *   region-constraint behavior and the alias-exact acceptance added for the 2026-06-11 demo
 *   resolver bugs. Integration coverage against the real hot DB lives in
 *   `resolver-wof-wasm/hot-db.test.ts` (env-gated on `MAILWOMAN_WOF_HOT_DB`).
 */

import { describe, expect, test, vi } from "vitest"

import { runCascade } from "./demo-helpers.js"
import type { MailwomanLookupLike } from "./resources.tsx"

type FindPlaceQuery = Parameters<MailwomanLookupLike["findPlace"]>[0]
type Hit = Awaited<ReturnType<MailwomanLookupLike["findPlace"]>>[number]

const NY_BBOX = { minLat: 40.4, maxLat: 45.1, minLon: -79.8, maxLon: -71.7 }

function hit(partial: Partial<Hit> & { id: number; name: string }): Hit {
	return { placetype: "locality", lat: 40, lon: -74, score: 1, ...partial }
}

function stubLookup(handler: (q: FindPlaceQuery) => Hit[]): MailwomanLookupLike {
	return { findPlace: vi.fn(async (q: FindPlaceQuery) => handler(q)) }
}

describe("runCascade", () => {
	test("warns and stays on the fuzzy backstop when the parsed region cannot be resolved", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		try {
			const lookup = stubLookup((q) => {
				if (q.placetype === "region") return [] // unresolvable region
				if (q.placetype === "locality") return [hit({ id: 1, name: "Brooklyn Park" })]
				return []
			})
			const hits = await runCascade(
				lookup,
				undefined,
				[{ tag: "locality", value: "Brooklynish" }],
				{
					tag: "region",
					value: "Nonexistia",
				},
				"Brooklynish, Nonexistia"
			)
			expect(hits.map((h) => h.id)).toEqual([1])
			expect(warn).toHaveBeenCalledWith(expect.stringContaining("did not resolve to a bbox"))
		} finally {
			warn.mockRestore()
		}
	})

	test("warns when the region-bbox pass finds no exact locality and the cascade widens", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		try {
			const lookup = stubLookup((q) => {
				if (q.placetype === "region") return [hit({ id: 10, name: "New York", placetype: "region", bbox: NY_BBOX })]
				if (q.placetype === "locality") {
					// Nothing inside the bbox; a fuzzy match only when unconstrained.
					return q.bbox ? [] : [hit({ id: 2, name: "Brooklyn Park" })]
				}
				return []
			})
			const hits = await runCascade(
				lookup,
				undefined,
				[{ tag: "locality", value: "brooklyn" }],
				{
					tag: "region",
					value: "new york",
				},
				"brooklyn, new york"
			)
			expect(hits.map((h) => h.id)).toEqual([2])
			expect(warn).toHaveBeenCalledWith(expect.stringContaining("retrying without the region constraint"))
		} finally {
			warn.mockRestore()
		}
	})

	test("accepts a backend alias-exact hit even when the canonical name differs from the query", async () => {
		// "New York City" is a WOF alias of the New York locality — the backend surfaces it as
		// exactMatch: true. The cascade must treat that as a real place (early accept), not a fuzzy
		// backstop it keeps scanning past.
		const lookup = stubLookup((q) => {
			if (q.placetype === "locality" && q.text === "New York City") {
				return [hit({ id: 85977539, name: "New York", exactMatch: true })]
			}
			// A later node with a canonical-name match — pre-fix the cascade would skip past the
			// alias-exact hit (treating it as fuzzy) and land here instead.
			if (q.placetype === "locality" && q.text === "Decoy") return [hit({ id: 999, name: "Decoy" })]
			return []
		})
		const hits = await runCascade(
			lookup,
			undefined,
			[
				{ tag: "locality", value: "New York City" },
				{ tag: "locality", value: "Decoy" },
			],
			undefined,
			"New York City"
		)
		expect(hits.map((h) => h.id)).toEqual([85977539])
	})

	test("region bbox constrains the locality lookup (bbox is forwarded to the backend)", async () => {
		const seen: FindPlaceQuery[] = []
		const lookup = stubLookup((q) => {
			seen.push(q)
			if (q.placetype === "region") return [hit({ id: 10, name: "New York", placetype: "region", bbox: NY_BBOX })]
			if (q.placetype === "locality" && q.bbox) return [hit({ id: 3, name: "Brooklyn", placetype: "borough" })]
			return []
		})
		const hits = await runCascade(
			lookup,
			undefined,
			[{ tag: "locality", value: "Brooklyn" }],
			{
				tag: "region",
				value: "new york",
			},
			"brooklyn, new york, ny"
		)
		expect(hits.map((h) => h.id)).toEqual([3])
		const localityQueries = seen.filter((q) => q.placetype === "locality")
		expect(localityQueries[0]?.bbox).toEqual(NY_BBOX)
	})
})
