/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { AddressNode } from "@mailwoman/core/decoder"
import { describe, expect, it } from "vitest"

import { CandidateResolverBackend, resolvedSpanResults, type MailwomanLookupLike } from "#browser-cascade"

const place = (id: number, name: string, placetype: string) => ({
	id,
	name,
	placetype,
	country: "GB",
	lat: 51.4,
	lon: -2.5,
	score: 1,
	exactMatch: true,
	bbox: { minLat: 51, maxLat: 52, minLon: -3, maxLon: -2 },
})

describe("CandidateResolverBackend", () => {
	it("reads a locality under a parent from the neighborhood band after the locality band misses", async () => {
		const asked: unknown[] = []

		const lookup: MailwomanLookupLike = {
			findPlace: async (query) => {
				asked.push(query.placetype)

				if (query.text === "Bristol") return [place(1, "Bristol", "region")]

				return Array.isArray(query.placetype) ? [place(2, "Brislington", "neighbourhood")] : []
			},
		}

		const backend = new CandidateResolverBackend(lookup)
		const [parent] = await backend.findPlace({ text: "Bristol", placetype: "region" })
		const [found] = await backend.findPlace({ text: "Brislington", placetype: "locality", parentID: parent!.id })

		expect(found?.name).toBe("Brislington")
		expect(asked).toEqual(["region", "locality", ["neighbourhood", "macrohood", "microhood"]])
	})
})

describe("resolvedSpanResults", () => {
	it("reports each place span in order, and leaves the street's parts to the street tier", () => {
		const node = (tag: string, value: string, start: number, extra: Partial<AddressNode> = {}) =>
			({ tag, value, start, end: start + value.length, confidence: 0.9, children: [], ...extra }) as AddressNode

		const matches = resolvedSpanResults([
			node("region", "Bristol", 30, {
				placeID: "wof:1",
				sourceID: "region:1",
				metadata: { resolver_name: "Bristol" },
				children: [node("locality", "Nowhere", 17), node("street", "Bristol", 3), node("house_number", "29", 0)],
			}),
		])

		expect(matches.map(({ tag, matched }) => [tag, matched])).toEqual([
			["street", false],
			["locality", false],
			["region", true],
		])

		expect(matches[2]).toMatchObject({ name: "Bristol", placetype: "region", placeID: "wof:1" })
	})
})
