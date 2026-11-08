// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import type { AddressNode } from "@mailwoman/core/decoder"
import { describe, expect, it } from "vitest"

import {
	CandidateResolverBackend,
	resolvedSpanResults,
	statedStreetScope,
	type MailwomanLookupLike,
} from "#browser-cascade"

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

describe("statedStreetScope", () => {
	it("lists resolved places deepest first, skips a landmark's id, and reads the country", () => {
		const node = (tag: string, placeID: string | null, extra: Partial<AddressNode> = {}) =>
			({
				tag,
				value: tag,
				start: 0,
				end: 1,
				confidence: 0.9,
				children: [],
				...(placeID ? { placeID, lat: 51, lon: -2 } : {}),
				...extra,
			}) as AddressNode

		const scope = statedStreetScope([
			node("country", "wof:85633159", {
				metadata: { resolver_country: "GB" },
				children: [
					node("locality", "wof:1175612699"),
					node("dependent_locality", "wof:85786019"),
					node("venue", "wof:7"),
					node("locality", "wikidata:Q1"),
					node("locality", null),
					node("postcode", "wof:9700000188925"),
				],
			}),
		])

		expect(scope.places.map(({ id }) => id)).toEqual([85_786_019, 1_175_612_699])
		expect(scope.postcodePoint).toEqual({ lat: 51, lon: -2 })
		expect(scope.country).toBe("GB")
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
