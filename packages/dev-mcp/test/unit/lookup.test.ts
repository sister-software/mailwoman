/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { loadFSTArtifact, lookupFST, lookupNormalize, lookupStreetMorphology } from "@mailwoman/dev-mcp/lookup"
import { describe, expect, it } from "vitest"

/**
 * A stub FST keyed on the joined token path, carrying the entries the real `fst-en-us.bin` returns for these surfaces.
 * The importances are the measured ones, so the zero below is the real gazetteer's zero rather than a convenient one.
 */
function stubFST(entries: Record<string, Array<{ wofID: number; placetype: string; referential: number }>>) {
	const paths = Object.keys(entries)

	return {
		walk(tokens: string[]) {
			const key = tokens.join(" ")

			return paths.includes(key) ? { stateID: paths.indexOf(key), accepted: true } : null
		},
		accepting(stateID: number) {
			return entries[paths[stateID]!] ?? []
		},
	}
}

const tokens = (surface: string): string[] => surface.toLowerCase().split(/\s+/)

describe("lookupFST", () => {
	const fst = stubFST({
		// Measured 2026-08-16 against fst-en-us.bin.
		"san juan": [{ wofID: 101_723_479, placetype: "locality", referential: 0.3733 }],
		juan: [{ wofID: 1_242_986_585, placetype: "locality", referential: 0 }],
		cook: [{ wofID: 102_081_171, placetype: "county", referential: 0.4948 }],
	})

	it("separates a zero-importance hit from a firing one", () => {
		// `applyBias` computes `importance * biasScale * maxBias * …` and keeps a tag only when that exceeds the running
		// max, which starts at 0. So a BIO-mapped entry at importance 0 contributes nothing to the decoder, and a caller
		// reading only `hit` and `importance` cannot tell that from a bias the decoder acts on.
		const [inert] = lookupFST(fst, tokens, ["Juan"])

		expect(inert!.entries).toEqual([{ tag: "locality", importance: 0, fires: false }])
		expect(inert!.note).toContain("INERT")
	})

	it("keeps a MISS apart from a zero", () => {
		// The whole point. `Juan` is known and scored zero; `Sultan Qaboos` is not known at all. A caller that conflated
		// them would read "the gazetteer gives this no weight" for a surface the gazetteer has never heard of.
		const [known, unknown] = lookupFST(fst, tokens, ["Juan", "Sultan Qaboos"])

		expect(known).toMatchObject({ hit: true })
		expect(known!.entries).toEqual([{ tag: "locality", importance: 0, fires: false }])

		expect(unknown).toMatchObject({ hit: false, entries: null })
		expect(unknown!.note).toContain("absence, not a zero bias")
	})

	it("reports the per-tag max, which is all the decoder reads", () => {
		const [row] = lookupFST(fst, tokens, ["San Juan"])

		expect(row!.entries).toEqual([{ tag: "locality", importance: 0.3733, fires: true }])
	})

	it("says explicitly when an accepted surface gives the decoder nothing", () => {
		// `county` is walked, deduped, and dropped without touching the emission matrix. An empty entry list here is a
		// third state — neither absence nor a zero — and it must say so.
		const [row] = lookupFST(fst, tokens, ["Cook"])

		expect(row).toMatchObject({ hit: true })
		expect(row!.entries).toEqual([])
		expect(row!.note).toContain("receives NOTHING")
		expect(row!.note).toContain("different from a zero")
	})
})

describe("lookupStreetMorphology", () => {
	const fst = stubFST({ street: [], road: [] })

	it("reports a hit and a miss", () => {
		const [hit, miss] = lookupStreetMorphology(fst, ["street", "qaboos"])

		expect(hit).toMatchObject({ hit: true })
		expect(miss).toMatchObject({ hit: false, entries: null })
	})

	it("notes when a multi-word query was walked, since this source answers about single words", () => {
		const [row] = lookupStreetMorphology(fst, ["main street"])

		expect(row!.note).toContain("2 tokens")
	})
})

describe("lookupNormalize", () => {
	it("always answers, and flags whether the input changed", () => {
		const [row] = lookupNormalize(["350 5th Ave"], "und")

		expect(row).toMatchObject({ hit: true })
		expect((row!.entries![0] as { normalized: string }).normalized).toBeTypeOf("string")
	})

	it("notes a change, which is the usual reason another source misses", () => {
		const rows = lookupNormalize(["  spaced   out  "], "und")

		expect((rows[0]!.entries![0] as { changed: boolean }).changed).toBe(true)
		expect(rows[0]!.note).toContain("downstream sources see")
	})
})

describe("loadFSTArtifact", () => {
	it("reports an unresolved path as unavailable rather than as an empty source", () => {
		// A source whose artifact is missing answers "no" to everything, which reads as absence for every query. That is
		// the one answer this must never give silently.
		expect(loadFSTArtifact(undefined, () => stubFST({}))).toEqual({
			unavailable: "No artifact path was resolved for this source.",
		})
	})

	it("reports a missing file by path", () => {
		const result = loadFSTArtifact("/nonexistent/fst.bin", () => stubFST({}))

		expect("unavailable" in result && result.unavailable).toContain("/nonexistent/fst.bin")
	})
})
