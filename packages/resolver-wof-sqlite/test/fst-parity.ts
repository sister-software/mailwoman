/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Compares the in-place FST matcher with the object matcher `deserializeFST` builds from the same bytes, over every
 *   state, every edge and every token path from the root.
 */

import { expect } from "vitest"

import type { BinaryFSTMatcher } from "#fst/binary-matcher"
import type { FSTMatcher } from "#fst/matcher"

/**
 * Asserts that both matchers answer every query identically, and returns the
 * number of states and edges compared.
 *
 * `absentTokens` are probed from every state and must reach no state in either matcher.
 */
export function expectMatcherParity(
	reference: FSTMatcher,
	candidate: BinaryFSTMatcher,
	absentTokens: readonly string[]
): { states: number; edges: number } {
	expect(candidate.stateCount).toBe(reference.stateCount)
	expect(candidate.placeCount).toBe(reference.placeCount)

	let edges = 0

	for (let stateID = 0; stateID < reference.stateCount; stateID++) {
		expect(candidate.accepting(stateID)).toEqual(reference.accepting(stateID))

		const continuations = reference.continuations(stateID)

		expect(candidate.continuations(stateID)).toEqual(continuations)

		const from = { stateID, accepted: reference.accepting(stateID).length > 0, depth: 3 }

		for (const { token } of continuations) {
			expect(candidate.walkFrom(from, token)).toEqual(reference.walkFrom(from, token))

			edges++
		}

		for (const token of absentTokens) {
			expect(candidate.walkFrom(from, token)).toEqual(reference.walkFrom(from, token))
		}
	}

	// Every token path from the root, depth first, walked whole.
	const pending: string[][] = [[]]

	while (pending.length) {
		const path = pending.pop()!
		const reached = reference.walk(path)

		expect(candidate.walk(path)).toEqual(reached)

		for (const token of absentTokens) {
			expect(candidate.walk([...path, token])).toEqual(reference.walk([...path, token]))
		}

		if (reached) {
			for (const { token } of reference.continuations(reached.stateID)) {
				pending.push([...path, token])
			}
		}
	}

	return { states: reference.stateCount, edges }
}
