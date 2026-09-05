/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The autocomplete ladder's pure half (#2154): which prefixes a row yields, and how a row's rungs fold into the
 *   first-hit, churn and abstention readings. No engine, no FST.
 */

import {
	ladderRungs,
	readRow,
	type RungReading,
	summarizeArm,
	type LadderRow,
} from "mailwoman/eval-harness/autocomplete-ladder"
import { describe, expect, it } from "vitest"

const rung = (prefix: string, hit: boolean, answers = hit ? 1 : 0, latencyMs = 10): RungReading => ({
	prefix,
	chars: prefix.length,
	answers: Array.from({ length: answers }, () => ({ lat: 0, lon: 0 })),
	hit,
	latencyMs,
})

describe("ladderRungs", () => {
	it("opens the first three keystrokes, then every token boundary, and ends on the full string", () => {
		expect(ladderRungs("Rua Augusta 100, Lisboa")).toEqual([
			"R",
			"Ru",
			"Rua",
			"Rua Augusta",
			"Rua Augusta 100",
			"Rua Augusta 100, Lisboa",
		])
	})

	it("trims the separator a screen has not sent yet, and never repeats a rung", () => {
		expect(ladderRungs("SW1A 2AA")).toEqual(["S", "SW", "SW1", "SW1A", "SW1A 2AA"])
		expect(ladderRungs("Köln")).toEqual(["K", "Kö", "Köl", "Köln"])
	})

	it("treats a comma run as one boundary", () => {
		expect(ladderRungs("Paris,  France")).toEqual(["P", "Pa", "Par", "Paris", "Paris,  France"])
	})
})

describe("readRow", () => {
	it("reads the first-hit rung in characters and as a fraction of the input", () => {
		const reading = readRow(
			[
				rung("R", false),
				rung("Ru", false),
				rung("Rua", false),
				rung("Rua Augusta", true),
				rung("Rua Augusta 100", true),
			],
			15
		)

		expect(reading.firstHitChars).toBe(11)
		expect(reading.firstHitFraction).toBeCloseTo(11 / 15)
		expect(reading.churn).toBe(0)
		expect(reading.fullStringHit).toBe(true)
	})

	it("counts every later rung that lost the truth as churn", () => {
		const reading = readRow(
			[rung("a", false), rung("ab", true), rung("abc", false), rung("abcd", true), rung("abcde", false)],
			5
		)

		expect(reading.firstHitChars).toBe(2)
		expect(reading.churn).toBe(2)
		expect(reading.fullStringHit).toBe(false)
	})

	it("reads null, not zero, for a row the truth never entered", () => {
		const reading = readRow([rung("a", false), rung("ab", false)], 2)

		expect(reading.firstHitChars).toBeNull()
		expect(reading.firstHitFraction).toBeNull()
		expect(reading.churn).toBeNull()
	})

	it("counts the one- and two-character rungs that answered anything as abstention misses", () => {
		const reading = readRow([rung("a", false, 1), rung("ab", false, 0), rung("abc", false, 3), rung("abcd", true)], 4)

		expect(reading.shortRungs).toBe(2)
		expect(reading.shortRungsAnswered).toBe(1)
	})
})

describe("summarizeArm", () => {
	const row = (id: string, headline: boolean, parseHit: number | null, churn: number): LadderRow => {
		const rungs = [
			rung("a", false, 1, 5),
			rung("ab cd", parseHit !== null, 1, 20),
			rung("ab cd ef", churn === 0 && parseHit !== null, 1, 30),
		]

		return {
			id,
			input: "ab cd ef",
			country: "PT",
			status: "pass",
			toleranceM: headline ? 3000 : 100_000,
			headline,
			fstLocale: "en-us",
			arms: {
				parse_resolve: readRow(rungs, 8),
				fst: readRow(
					rungs.map((r) => ({ ...r, hit: false })),
					8
				),
			},
		}
	}

	it("summarizes the headline rows only, with the denominators stated", () => {
		const summary = summarizeArm("parse_resolve", [row("a", true, 5, 0), row("b", true, 5, 1), row("c", false, 5, 0)])

		expect(summary.rows).toBe(2)
		expect(summary.rowsHit).toBe(2)
		expect(summary.churnRows).toBe(1)
		expect(summary.medianFirstHitFraction).toBeCloseTo(5 / 8)
		expect(summary.shortRungs).toBe(2)
		expect(summary.shortRungsAnswered).toBe(2)
		expect(summary.latency.find((band) => band.band === "1-2")?.n).toBe(2)
		expect(summary.latency.find((band) => band.band === "13+")?.n).toBe(0)
	})

	it("counts a row whose country has no FST out of the fst arm's denominators, not as a miss", () => {
		const noArtifact = { ...row("a", true, 5, 0), fstLocale: null }
		const summary = summarizeArm("fst", [noArtifact, row("b", true, 5, 0)])

		expect(summary.rows).toBe(1)
		expect(summary.rowsWithoutArtifact).toBe(1)
		expect(summarizeArm("parse_resolve", [noArtifact]).rows).toBe(1)
	})

	it("reports null medians and zero hits when nothing hit, never a zero fraction", () => {
		const summary = summarizeArm("fst", [row("a", true, 5, 0)])

		expect(summary.rowsHit).toBe(0)
		expect(summary.medianFirstHitFraction).toBeNull()
	})
})
