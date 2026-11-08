// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import type { AddressNode } from "@mailwoman/core/decoder"
import { EMPTY_PLACE_FIELDS, type ResolvedPlace, type ResolverBackend } from "@mailwoman/core/resolver"
import { describe, expect, it } from "vitest"

import { applyWholeInputPlace } from "#resolve/whole-input"

const MUNICH: ResolvedPlace = {
	...EMPTY_PLACE_FIELDS,
	id: 101_748_479,
	name: "München",
	placetype: "locality",
	country: "DE",
	lat: 48.152126,
	lon: 11.544467,
	score: 5,
	exactMatch: true,
}

function node(tag: string, value: string, start: number, extra: Partial<AddressNode> = {}): AddressNode {
	return { tag, value, start, end: start + value.length, confidence: 0.4, children: [], ...extra } as AddressNode
}

const backendOf = (places: ResolvedPlace[]): ResolverBackend => ({ findPlace: async () => places })

const fragments = () => [node("dependent_locality", "ミュ", 0), node("locality_unit", "ンヘン", 2)]

describe("applyWholeInputPlace", () => {
	it("reads unresolved fragments as the place the whole text names", async () => {
		const roots = fragments()

		await applyWholeInputPlace(roots, "ミュンヘン", backendOf([MUNICH]), null)

		expect(roots).toHaveLength(1)
		expect(roots[0]).toMatchObject({ tag: "locality", value: "ミュンヘン", placeID: "wof:101748479", lat: MUNICH.lat })
	})

	it("reads a lone unresolved venue as the place the whole text names", async () => {
		const roots = [node("venue", "ミュンヘン", 0)]

		await applyWholeInputPlace(roots, "ミュンヘン", backendOf([MUNICH]), null)

		expect(roots[0]).toMatchObject({ tag: "locality", placeID: "wof:101748479" })
	})

	it("leaves a lone admin span, which the walk already looked up, and passes the caller's country", async () => {
		const asked: unknown[] = []

		const recording: ResolverBackend = {
			findPlace: async (query) => {
				asked.push(query)

				return [MUNICH]
			},
		}

		const lone = [node("locality", "ミュンヘン", 0)]

		await applyWholeInputPlace(lone, "ミュンヘン", recording, "US")
		await applyWholeInputPlace(fragments(), "ミュンヘン", recording, "US")

		expect(lone[0]!.placeID).toBeUndefined()
		expect(asked).toEqual([{ text: "ミュンヘン", country: "US" }])
	})

	it("keeps the parse when the whole text names no place exactly", async () => {
		const roots = fragments()

		await applyWholeInputPlace(roots, "ミュンヘン", backendOf([{ ...MUNICH, exactMatch: false }]), null)

		expect(roots).toHaveLength(2)
	})

	it("keeps a parse whose parts resolved, and an input with separators", async () => {
		const resolved = [node("locality", "上海市", 0, { placeID: "wof:1" }), node("street", "人民路", 3)]

		await applyWholeInputPlace(resolved, "上海市人民路", backendOf([MUNICH]), null)

		const spaced = [node("street", "Main", 0), node("locality", "Street", 5)]

		await applyWholeInputPlace(spaced, "Main Street", backendOf([MUNICH]), null)

		expect(resolved[0]!.tag).toBe("locality")
		expect(resolved).toHaveLength(2)
		expect(spaced).toHaveLength(2)
	})
})
