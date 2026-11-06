/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { AddressNode } from "@mailwoman/core/decoder"
import type { LandmarkHit, LandmarkLookup } from "@mailwoman/core/resolver"
import { describe, expect, it } from "vitest"

import { applyLandmark } from "#resolve/landmark"

function hit(overrides: Partial<LandmarkHit> & Pick<LandmarkHit, "qid" | "name">): LandmarkHit {
	return {
		kind: "venue",
		country: "US",
		lat: 40.78,
		lon: -73.96,
		sitelinks: 50,
		primary: true,
		code: false,
		...overrides,
	}
}

const LONDON_PARK = hit({ qid: "Q123738", name: "Hyde Park", country: "GB", lat: 51.5, lon: -0.16, sitelinks: 63 })
const CHICAGO_AREA = hit({ qid: "Q3143666", name: "Hyde Park", lat: 41.8, lon: -87.59, sitelinks: 13 })
const lookup = (hits: LandmarkHit[]): LandmarkLookup => ({ find: () => hits })

function node(tag: string, value: string, start: number, extra: Partial<AddressNode> = {}): AddressNode {
	return { tag, value, start, end: start + value.length, confidence: 0.9, children: [], ...extra } as AddressNode
}

describe("applyLandmark", () => {
	it("replaces a wrong parse of a bare name with the leader and its alternatives", async () => {
		const roots = [node("street", "Hyde", 0), node("street_suffix", "Park", 5)]

		await applyLandmark(roots, "Hyde Park", lookup([LONDON_PARK, CHICAGO_AREA]))

		expect(roots).toHaveLength(1)
		expect(roots[0]).toMatchObject({ tag: "venue", value: "Hyde Park", lat: 51.5, placeID: "wikidata:Q123738" })
		expect(roots[0]!.alternatives).toHaveLength(1)
	})

	it("states prominence as log10 sitelinks, the scale the ambiguity margin reads", async () => {
		const roots = [node("venue", "Hyde Park", 0)]

		await applyLandmark(roots, "Hyde Park", lookup([hit({ qid: "Q1", name: "Hyde Park", sitelinks: 99 })]))

		expect(roots[0]!.metadata?.["resolver_prominence"]).toBeCloseTo(2)
	})

	it("leaves a name a settlement leads to the admin ladder", async () => {
		const roots = [node("locality", "Paris", 0)]

		await applyLandmark(roots, "Paris", lookup([hit({ qid: "Q90", name: "Paris", kind: "settlement" })]))

		expect(roots[0]!.tag).toBe("locality")
	})

	it("leaves an address alone", async () => {
		const roots = [node("venue", "Hyde Park", 0), node("postcode", "W2 2UH", 11)]

		await applyLandmark(roots, "Hyde Park, W2 2UH", lookup([LONDON_PARK]))

		expect(roots).toHaveLength(2)
		expect(roots[0]!.lat).toBeUndefined()
	})

	it("keeps an alias from taking a name the gazetteer resolved", async () => {
		const resolved = node("locality", "Hamburg", 0, { placeID: "wof:1", lat: 53.5, lon: 10 })
		const alias = hit({ qid: "Q27706", name: "Hamburg Airport", country: "DE", primary: false })
		const roots = [resolved]

		await applyLandmark(roots, "Hamburg", lookup([alias]))

		expect(roots[0]).toBe(resolved)
	})

	it("lets a code written in its own case take a name the gazetteer resolved", async () => {
		const roots = [node("locality", "Lax", 0, { placeID: "wof:1", lat: 46.4, lon: 8.1 })]
		const airport = hit({ qid: "Q8731", name: "Los Angeles International Airport", primary: false, code: true })

		await applyLandmark(roots, "LAX", lookup([airport]))

		expect(roots[0]!.placeID).toBe("wikidata:Q8731")
	})

	describe("with a code a country claims", () => {
		const AUSTRALIA = { placeID: "wof:85632793", lat: -25, lon: 134, metadata: { resolver_country: "AU" } }
		const AUSTIN = hit({ qid: "Q1430913", name: "Austin-Bergstrom International Airport", code: true, sitelinks: 34 })

		it("keeps the country as the answer and lists the airport holding the code", async () => {
			const roots = [node("country", "AUS", 0, AUSTRALIA)]

			await applyLandmark(roots, "AUS", lookup([AUSTIN]))

			expect(roots).toHaveLength(1)
			expect(roots[0]!.placeID).toBe("wof:85632793")
			expect(roots[0]!.alternatives).toMatchObject([{ id: "Q1430913", placetype: "venue", country: "US" }])
			expect(roots[0]!.metadata?.["code_collision"]).toBe(true)
		})

		it("records the registry's verdict when no landmark holds the code", async () => {
			const roots = [node("country", "GBR", 0, { ...AUSTRALIA, metadata: { resolver_country: "GB" } })]

			await applyLandmark(roots, "GBR", lookup([]))

			expect(roots[0]!.metadata?.["code_collision"]).toBe(true)
			expect(roots[0]!.alternatives).toBeUndefined()
		})

		it("lists no word spelled like the code", async () => {
			const roots = [node("country", "USA", 0, { ...AUSTRALIA, metadata: { resolver_country: "US" } })]
			const usa = hit({ qid: "Q1041977", name: "Usa", kind: "settlement", country: "JP", code: false })

			await applyLandmark(roots, "USA", lookup([usa]))

			expect(roots[0]!.alternatives).toBeUndefined()
		})

		it("leaves an unresolved country alone", async () => {
			const roots = [node("venue", "AUS", 0)]

			await applyLandmark(roots, "AUS", lookup([AUSTIN]))

			expect(roots[0]).toMatchObject({ tag: "venue", value: "AUS" })
			expect(roots[0]!.placeID).toBeUndefined()
		})
	})

	it("lets an alias answer a name the gazetteer left unresolved", async () => {
		const roots = [node("locality", "Dtw", 0)]
		const airport = hit({ qid: "Q1", name: "Detroit Metropolitan Wayne County Airport", primary: false })

		await applyLandmark(roots, "DTW", lookup([airport]))

		expect(roots[0]!.placeID).toBe("wikidata:Q1")
	})

	it("writes a name's value with its spacing and Unicode form normalized", async () => {
		const roots = [node("venue", "Hyde  Park", 0)]

		await applyLandmark(roots, "Hyde  Park", lookup([LONDON_PARK]))

		expect(roots[0]!.value).toBe("Hyde Park")
	})

	describe("with a name the parser reads as a street", () => {
		const street = (value: string, suffix: string) => [
			node("street", value, 0),
			node("street_suffix", suffix, value.length + 1),
		]

		it("answers a famous street from Wikidata and keeps it a street", async () => {
			const roots = street("Downing", "Street")

			await applyLandmark(roots, "Downing Street", lookup([hit({ qid: "Q1", name: "Downing Street" })]))

			expect(roots[0]).toMatchObject({ tag: "street", value: "Downing Street", lat: 40.78 })
		})

		it("keeps the street when the hit is an alias of another place", async () => {
			const roots = street("Baker", "Street")

			await applyLandmark(
				roots,
				"Baker Street",
				lookup([hit({ qid: "Q2", name: "Baker Street tube station", primary: false })])
			)

			expect(roots[0]).toMatchObject({ tag: "street", value: "Baker" })
		})

		it("keeps the street over an OpenStreetMap place of that spelling", async () => {
			const roots = street("Wall", "Street")

			await applyLandmark(roots, "Wall Street", lookup([hit({ qid: "osm:W7", name: "Wall Street" })]))

			expect(roots[0]).toMatchObject({ tag: "street", value: "Wall" })
		})

		it("answers a park the parser read as a street with the suffix Park", async () => {
			const roots = street("Piedmont", "Park")

			await applyLandmark(roots, "Piedmont Park", lookup([hit({ qid: "osm:W8", name: "Piedmont Park" })]))

			expect(roots[0]).toMatchObject({ tag: "venue", value: "Piedmont Park" })
		})
	})

	describe("an OpenStreetMap place", () => {
		const park = hit({ qid: "osm:W1", name: "Piedmont Park", primary: false, importance: 0.3, lat: 33.79, lon: -84.37 })

		it("answers a name the walk resolved only in part, crediting OpenStreetMap", async () => {
			const roots = [node("locality", "Piedmont", 0, { placeID: "wof:1" })]

			await applyLandmark(roots, "Piedmont Park", lookup([park]))

			expect(roots[0]).toMatchObject({ placeID: "openstreetmap:W1", tag: "venue" })
			expect(roots[0]!.metadata?.["landmark_source"]).toBe("openstreetmap:planet")
		})

		it("keeps a place with no measured population unless the parser read a park", async () => {
			const vogel = [node("locality", "Vogel", 0, { placeID: "wof:6", metadata: { resolver_score: 0 } })]

			await applyLandmark(vogel, "Vogel", lookup([hit({ qid: "osm:W9", name: "Vogel" })]))

			expect(vogel[0]!.placeID).toBe("wof:6")
		})

		it("answers a park over a row with no measured population holding the whole name", async () => {
			const roots = [
				node("locality", "Piedmont Park", 0, {
					placeID: "wof:5",
					metadata: { resolver_score: 0 },
					children: [node("street_suffix", "Park", 9)],
				}),
			]

			await applyLandmark(roots, "Piedmont Park", lookup([park]))

			expect(roots[0]!.placeID).toBe("openstreetmap:W1")
		})

		it("leaves a town nested under its region that holds the whole name", async () => {
			const town = node("locality", "New York", 0, { placeID: "wof:2", metadata: { resolver_score: 6.9 } })
			const region = node("region", "NY", 10, { placeID: "wof:3", children: [town] })

			await applyLandmark([region], "New York, NY", lookup([hit({ ...park, name: "New York" })]))

			expect(region.tag).toBe("region")
			expect(town.tag).toBe("locality")
		})

		it("stays inside a stated town's extent, and takes the nearest namesake there", async () => {
			const fondDuLac = {
				placeID: "wof:4",
				lat: 43.77,
				lon: -88.44,
				metadata: {
					resolver_country: "US",
					resolver_bbox: { minLat: 43.74, maxLat: 43.81, minLon: -88.5, maxLon: -88.4 },
				},
			}

			const near = hit({
				qid: "osm:W2",
				name: "Lakeside Park",
				primary: false,
				importance: 0.1,
				lat: 43.795,
				lon: -88.442,
			})

			const out = hit({
				qid: "osm:W3",
				name: "Lakeside Park",
				primary: false,
				importance: 0.5,
				lat: 43.9,
				lon: -88.442,
			})

			const roots = [node("venue", "Lakeside Park", 0), node("locality", "Fond du Lac", 15, fondDuLac)]

			await applyLandmark(roots, "Lakeside Park, Fond du Lac", lookup([out, near]))

			expect(roots[0]!.placeID).toBe("openstreetmap:W2")
		})
	})

	describe("with context beside the name", () => {
		const CHICAGO = { placeID: "wof:2", lat: 41.88, lon: -87.63, metadata: { resolver_country: "US" } }

		it("reads the namesake inside the stated locality", async () => {
			const roots = [node("venue", "Hyde Park", 0), node("locality", "Chicago", 11, CHICAGO)]

			await applyLandmark(roots, "Hyde Park, Chicago", lookup([LONDON_PARK, CHICAGO_AREA]))

			expect(roots[0]!.placeID).toBe("wikidata:Q3143666")
			expect(roots[1]!.tag).toBe("locality")
		})

		it("answers no namesake outside the stated country", async () => {
			const roots = [node("venue", "Hyde Park", 0), node("locality", "Chicago", 11, CHICAGO)]

			await applyLandmark(roots, "Hyde Park, Chicago", lookup([LONDON_PARK]))

			expect(roots[0]!.placeID).toBeUndefined()
		})

		it("leaves the parse alone when the context resolved no place", async () => {
			const roots = [node("venue", "Hyde Park", 0), node("locality", "Nowhere", 11)]

			await applyLandmark(roots, "Hyde Park, Nowhere", lookup([LONDON_PARK]))

			expect(roots).toHaveLength(2)
			expect(roots[0]!.placeID).toBeUndefined()
		})
	})
})
