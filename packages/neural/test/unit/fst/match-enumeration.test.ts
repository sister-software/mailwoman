import {
	findFSTAcceptedMatches,
	type FSTMatcherLike,
	type FSTMatchLike,
	type FSTPlaceEntryLike,
} from "@mailwoman/neural/fst-prior"
import { describe, expect, it } from "vitest"

function mockFST(entries: ReadonlyMap<string, FSTPlaceEntryLike[]>): FSTMatcherLike {
	const paths = [...entries.keys()].map((path) => path.split(" "))
	const states = new Map<string, number>()
	let nextState = 1

	for (const path of paths) {
		for (let length = 1; length <= path.length; length++) {
			const prefix = path.slice(0, length).join(" ")

			if (!states.has(prefix)) {
				states.set(prefix, nextState++)
			}
		}
	}

	const pathByState = new Map([...states].map(([path, state]) => [state, path]))

	return {
		walk(tokens): FSTMatchLike | null {
			const path = tokens.join(" ")
			const stateID = states.get(path)

			return stateID === undefined ? null : { stateID, accepted: entries.has(path), depth: tokens.length }
		},
		walkFrom(previous, token): FSTMatchLike | null {
			const previousPath = pathByState.get(previous.stateID)

			if (!previousPath) return null

			return this.walk([...previousPath.split(" "), token])
		},
		accepting(stateID) {
			return entries.get(pathByState.get(stateID) ?? "") ?? []
		},
	}
}

describe("findFSTAcceptedMatches", () => {
	it("reports nested and covering matches without preferring either", () => {
		const fst = mockFST(
			new Map([
				["spain", [{ wofID: 1, placetype: "country", referential: 0.9 }]],
				["port of spain", [{ wofID: 2, placetype: "locality", referential: 0.7 }]],
			])
		)

		const pieces = ["Port", "of", "Spain"].map((word) => ({ piece: `▁${word}` }))

		expect(findFSTAcceptedMatches(fst, pieces)).toEqual([
			expect.objectContaining({ startPiece: 0, endPiece: 3, startWord: 0, endWord: 3 }),
			expect.objectContaining({ startPiece: 2, endPiece: 3, startWord: 2, endWord: 3 }),
		])
	})

	it("uses the same punctuation-transparent word grouping as the emission prior", () => {
		const fst = mockFST(new Map([["washington", [{ wofID: 3, placetype: "locality", referential: 0.8 }]]]))
		const pieces = [{ piece: "▁Washington" }, { piece: "," }, { piece: "▁DC" }]

		expect(findFSTAcceptedMatches(fst, pieces)[0]).toMatchObject({ startPiece: 0, endPiece: 2 })
	})
})
