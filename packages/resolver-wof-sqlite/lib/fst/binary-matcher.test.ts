/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

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
				wofID: Math.floor(random() * 2 ** 31),
				placetype: pick(PLACETYPE_ORDER),
				name: `${token} ${index}`,
				parentChain: Array.from({ length: Math.floor(random() * 6) }, () => Math.floor(random() * 2 ** 31)),
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
})
