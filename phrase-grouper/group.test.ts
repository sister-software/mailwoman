/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Contract smoke test for the FIRST commit. Verifies the public surface compiles, the async wrapper
 *   resolves, and the stub returns an empty proposal list. The kryptonite-catalogue fixture test
 *   lives in `kryptonite.test.ts` (added in the follow-up implementation commit).
 */

import { describe, expect, it } from "vitest"
import { groupPhrases, groupPhrasesSync } from "./group.js"
import type { NormalizedInputLite, PhraseGrouper, PhraseProposal, QueryShapeLike } from "./types.js"

function input(normalized: string): NormalizedInputLite {
	return { raw: normalized, normalized }
}

function shape(opts: Partial<QueryShapeLike> = {}): QueryShapeLike {
	return { knownFormats: [], ...opts }
}

describe("phrase-grouper — contract (stub)", () => {
	it("groupPhrasesSync returns an array", () => {
		const out: PhraseProposal[] = groupPhrasesSync(input("anything"), shape())
		expect(Array.isArray(out)).toBe(true)
	})

	it("groupPhrases async wrapper resolves to an array", async () => {
		const out = await groupPhrases(input("anything"), shape())
		expect(Array.isArray(out)).toBe(true)
	})

	it("stub returns an empty list — implementation lands in the next commit", () => {
		expect(groupPhrasesSync(input("350 5th Ave"), shape())).toEqual([])
	})

	it("satisfies the PhraseGrouper structural type", () => {
		const grouper: PhraseGrouper = { group: groupPhrases }
		expect(typeof grouper.group).toBe("function")
	})
})
