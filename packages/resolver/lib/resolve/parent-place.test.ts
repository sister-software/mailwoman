// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import type { AddressTree } from "@mailwoman/core/decoder"
import { EMPTY_PLACE_FIELDS, type ResolvedPlace, type ResolverBackend } from "@mailwoman/core/resolver"
import { describe, expect, it } from "vitest"

import { createWOFResolver } from "#resolve"

const GB_ID = 85_633_159
const LONDON_ID = 101_750_367
const CAMDEN_GB_ID = 1_158_857_277

const place = (id: number, placetype: string, country: string, prominence: number): ResolvedPlace => ({
	...EMPTY_PLACE_FIELDS,
	id,
	name: "Camden",
	placetype,
	country,
	lat: country === "GB" ? 51.54 : 39.93,
	lon: country === "GB" ? -0.14 : -75.11,
	score: prominence,
	prominence,
	exactMatch: true,
})

const CAMDEN_US = [1, 2, 3].map((id) => place(id, "locality", "US", 4.8 - id / 10))
const CAMDEN_GB = place(CAMDEN_GB_ID, "borough", "GB", 0)

const LINEAGE: Record<number, Array<{ id: number; placetype: string; name: string }>> = {
	[CAMDEN_GB_ID]: [
		{ id: LONDON_ID, placetype: "locality", name: "London" },
		{ id: GB_ID, placetype: "country", name: "United Kingdom" },
	],
	[LONDON_ID]: [{ id: GB_ID, placetype: "country", name: "United Kingdom" }],
}

/**
 * A backend whose unscoped fetch holds only US rows, as the 86-row `camden` key's population order does.
 */
const backend: ResolverBackend = {
	async findPlace(query) {
		if (query.placetype !== "locality") return []

		if (query.country === "GB") return [{ ...CAMDEN_GB, containedByQualifier: query.parentQualifierID ? true : null }]

		if (query.country) return []

		return CAMDEN_US.map((c) => ({ ...c, containedByQualifier: query.parentQualifierID ? false : null }))
	},
	ancestors: (id) => LINEAGE[Number(id)] ?? [],
	place: (id) => (id === LONDON_ID ? { ...place(LONDON_ID, "locality", "GB", 6.9), name: "London" } : null),
}

const CAMDEN: AddressTree = {
	raw: "Camden",
	roots: [{ tag: "locality", value: "Camden", start: 0, end: 6, confidence: 0.9, children: [] }],
}

describe("caller parent place", () => {
	it("keeps a hard parent's contained place and reports the excluded ones outside the scope", async () => {
		const out = await createWOFResolver(backend).resolveTree(CAMDEN, {
			parentPlace: { id: LONDON_ID, source: "caller", strength: "hard" },
			scopeCountryRetrieval: true,
		})

		const considered = (out.roots[0]?.considered ?? []) as ResolvedPlace[]

		expect(out.roots[0]?.placeID).toBe(`wof:${CAMDEN_GB_ID}`)

		expect(considered.map((c) => [c.id, c.outsideScope])).toEqual([
			[1, true],
			[2, true],
			[3, true],
		])
	})

	it("ranks a soft parent's country inside retrieval, so its contained place is a candidate", async () => {
		const out = await createWOFResolver(backend).resolveTree(CAMDEN, {
			parentPlace: { id: LONDON_ID, source: "caller", strength: "soft" },
		})

		const weighed = [
			out.roots[0]?.placeID,
			...(out.roots[0]?.alternatives ?? []).map((a) => `wof:${(a as ResolvedPlace).id}`),
		]

		expect(weighed).toContain(`wof:${CAMDEN_GB_ID}`)
	})

	it("throws on a parent id the gazetteer doesn't hold instead of answering unscoped", async () => {
		await expect(
			createWOFResolver(backend).resolveTree(CAMDEN, { parentPlace: { id: 42, source: "caller", strength: "hard" } })
		).rejects.toThrow(/holds no place/u)
	})

	it("throws on a hard parent outside the caller's default country", async () => {
		await expect(
			createWOFResolver(backend).resolveTree(CAMDEN, {
				defaultCountry: { country: "US", source: "caller" },
				parentPlace: { id: LONDON_ID, source: "caller", strength: "hard" },
			})
		).rejects.toThrow(/outside the default country/u)
	})
})
