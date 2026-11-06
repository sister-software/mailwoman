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
	it("replaces a wrong parse of a bare name with the leader and its alternatives", () => {
		const roots = [node("street", "Hyde", 0), node("street_suffix", "Park", 5)]

		applyLandmark(roots, "Hyde Park", lookup([LONDON_PARK, CHICAGO_AREA]))

		expect(roots).toHaveLength(1)
		expect(roots[0]).toMatchObject({ tag: "venue", value: "Hyde Park", lat: 51.5, placeID: "wikidata:Q123738" })
		expect(roots[0]!.alternatives).toHaveLength(1)
	})

	it("states prominence as log10 sitelinks, the scale the ambiguity margin reads", () => {
		const roots = [node("venue", "Hyde Park", 0)]

		applyLandmark(roots, "Hyde Park", lookup([hit({ qid: "Q1", name: "Hyde Park", sitelinks: 99 })]))

		expect(roots[0]!.metadata?.["resolver_prominence"]).toBeCloseTo(2)
	})

	it("leaves a name a settlement leads to the admin ladder", () => {
		const roots = [node("locality", "Paris", 0)]

		applyLandmark(roots, "Paris", lookup([hit({ qid: "Q90", name: "Paris", kind: "settlement" })]))

		expect(roots[0]!.tag).toBe("locality")
	})

	it("leaves an address alone", () => {
		const roots = [node("venue", "Hyde Park", 0), node("postcode", "W2 2UH", 11)]

		applyLandmark(roots, "Hyde Park, W2 2UH", lookup([LONDON_PARK]))

		expect(roots).toHaveLength(2)
		expect(roots[0]!.lat).toBeUndefined()
	})

	it("keeps an alias from taking a name the gazetteer resolved", () => {
		const resolved = node("locality", "Hamburg", 0, { placeID: "wof:1", lat: 53.5, lon: 10 })
		const alias = hit({ qid: "Q27706", name: "Hamburg Airport", country: "DE", primary: false })
		const roots = [resolved]

		applyLandmark(roots, "Hamburg", lookup([alias]))

		expect(roots[0]).toBe(resolved)
	})

	it("lets a code written in its own case take a name the gazetteer resolved", () => {
		const roots = [node("locality", "Lax", 0, { placeID: "wof:1", lat: 46.4, lon: 8.1 })]
		const airport = hit({ qid: "Q8731", name: "Los Angeles International Airport", primary: false, code: true })

		applyLandmark(roots, "LAX", lookup([airport]))

		expect(roots[0]!.placeID).toBe("wikidata:Q8731")
	})

	it("lets an alias answer a name the gazetteer left unresolved", () => {
		const roots = [node("locality", "Dtw", 0)]
		const airport = hit({ qid: "Q1", name: "Detroit Metropolitan Wayne County Airport", primary: false })

		applyLandmark(roots, "DTW", lookup([airport]))

		expect(roots[0]!.placeID).toBe("wikidata:Q1")
	})

	describe("with context beside the name", () => {
		const CHICAGO = { placeID: "wof:2", lat: 41.88, lon: -87.63, metadata: { resolver_country: "US" } }

		it("reads the namesake inside the stated locality", () => {
			const roots = [node("venue", "Hyde Park", 0), node("locality", "Chicago", 11, CHICAGO)]

			applyLandmark(roots, "Hyde Park, Chicago", lookup([LONDON_PARK, CHICAGO_AREA]))

			expect(roots[0]!.placeID).toBe("wikidata:Q3143666")
			expect(roots[1]!.tag).toBe("locality")
		})

		it("answers no namesake outside the stated country", () => {
			const roots = [node("venue", "Hyde Park", 0), node("locality", "Chicago", 11, CHICAGO)]

			applyLandmark(roots, "Hyde Park, Chicago", lookup([LONDON_PARK]))

			expect(roots[0]!.placeID).toBeUndefined()
		})

		it("leaves the parse alone when the context resolved no place", () => {
			const roots = [node("venue", "Hyde Park", 0), node("locality", "Nowhere", 11)]

			applyLandmark(roots, "Hyde Park, Nowhere", lookup([LONDON_PARK]))

			expect(roots).toHaveLength(2)
			expect(roots[0]!.placeID).toBeUndefined()
		})
	})
})
