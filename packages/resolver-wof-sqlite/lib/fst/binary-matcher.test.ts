// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { mulberry32 } from "@mailwoman/core/random"
import { describe, expect, test } from "vitest"

import { BinaryFSTMatcher } from "#fst/binary-matcher"
import { PLACETYPE_ORDER } from "#fst/format"
import { FSTMatcher, type FSTNode } from "#fst/matcher"
import { deserializeFST, serializeFST } from "#fst/serialize"
import type { PlaceEntry } from "#fst/types"

import { expectMatcherParity } from "../../test/fst-parity.ts"

const VOCABULARY = [
	"saint",
	"san",
	"new",
	"york",
	"paris",
	"springfield",
	"東京",
	"são",
	"paulo",
	"köln",
	"north",
	"1st",
]

/**
 * Builds a seeded random trie of `stateCount` states whose tokens repeat across states,
 * so the token table and the edge table both see collisions.
 */
function randomMatcher(seed: number, stateCount: number, withAmbiguity: boolean): FSTMatcher {
	const random = mulberry32(seed)
	const pick = <T>(values: readonly T[]): T => values[Math.floor(random() * values.length)]!
	// A fifth of the ids come from the `mailwoman` fork range, above the u32 maximum.
	const randomID = () => (random() < 0.2 ? 9_895_000_000 + Math.floor(random() * 1e6) : Math.floor(random() * 2 ** 31))
	const nodes: FSTNode[] = [{ edges: new Map(), places: [] }]

	for (let stateID = 1; stateID < stateCount; stateID++) {
		let parent: FSTNode
		let token: string

		do {
			parent = nodes[Math.floor(random() * nodes.length)]!
			token = random() < 0.7 ? pick(VOCABULARY) : `${pick(VOCABULARY)}${Math.floor(random() * 500)}`
		} while (parent.edges.has(token))

		parent.edges.set(token, stateID)

		const places: PlaceEntry[] = []
		const placeCount = random() < 0.4 ? 0 : Math.floor(random() * 4)

		for (let index = 0; index < placeCount; index++) {
			places.push({
				wofID: randomID(),
				placetype: pick(PLACETYPE_ORDER),
				name: `${token} ${index}`,
				parentChain: Array.from({ length: Math.floor(random() * 6) }, randomID),
				referential: Math.fround(random()),
				encyclopedic: random() < 0.5 ? Math.fround(random()) : null,
				lat: Math.fround(random() * 180 - 90),
				lon: Math.fround(random() * 360 - 180),
				crossCountryBranches: withAmbiguity ? Math.floor(random() * 255) : null,
			})
		}

		nodes.push({ edges: new Map(), places })
	}

	return FSTMatcher.fromNodes(nodes)
}

describe("BinaryFSTMatcher", () => {
	test.each([
		{ seed: 1, stateCount: 2000, withAmbiguity: true },
		{ seed: 7, stateCount: 5000, withAmbiguity: false },
	])("answers like the object matcher over a random trie (seed $seed)", ({ seed, stateCount, withAmbiguity }) => {
		const bytes = serializeFST(randomMatcher(seed, stateCount, withAmbiguity))
		const compared = expectMatcherParity(deserializeFST(bytes), new BinaryFSTMatcher(bytes), ["absent", "", "Paris"])

		expect(compared).toEqual({ states: stateCount, edges: stateCount - 1 })
	})

	test("reads a buffer at a non-zero offset", () => {
		const bytes = serializeFST(randomMatcher(3, 200, true))
		const padded = new Uint8Array(bytes.byteLength + 5)

		padded.set(bytes, 5)

		expectMatcherParity(deserializeFST(bytes), new BinaryFSTMatcher(padded.subarray(5)), ["absent"])
	})

	test("query walks as far as the tokens match", () => {
		const nodes: FSTNode[] = [
			{ edges: new Map([["new", 1]]), places: [] },
			{ edges: new Map([["york", 2]]), places: [] },
			{ edges: new Map(), places: [] },
		]

		const bytes = serializeFST(FSTMatcher.fromNodes(nodes))
		const matcher = new BinaryFSTMatcher(bytes)

		expect(matcher.query("New York")).toEqual(deserializeFST(bytes).query("New York"))
		expect(matcher.query("new jersey")).toMatchObject({ path: ["new"], stateID: 1 })
	})

	test("keeps a WOF id above the u32 maximum, and its parent ids, through both readers", () => {
		const fivePoints: PlaceEntry = {
			wofID: 9_895_000_000,
			placetype: "neighbourhood",
			name: "five points",
			parentChain: [9_895_000_001, 101_713_359],
			referential: 0,
			encyclopedic: null,
			lat: Math.fround(41.084779),
			lon: Math.fround(-81.53583),
			crossCountryBranches: null,
		}

		const bytes = serializeFST(
			FSTMatcher.fromNodes([
				{ edges: new Map([["five", 1]]), places: [] },
				{ edges: new Map([["points", 2]]), places: [] },
				{ edges: new Map(), places: [fivePoints] },
			])
		)

		expect(deserializeFST(bytes).query("five points").accepting).toEqual([fivePoints])
		expect(new BinaryFSTMatcher(bytes).query("five points").accepting).toEqual([fivePoints])
	})
})
