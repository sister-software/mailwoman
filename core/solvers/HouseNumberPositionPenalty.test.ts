/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { Alpha2LanguageCode, Solution, SolutionMatch, Span } from "@mailwoman/core"
import { expect, test } from "vitest"

import { HouseNumberPositionPenalty } from "./HouseNumberPositionPenalty.ts"

/**
 * Build a `street` match carrying a single language so the solver can read `street.languages`. The solver keys its
 * language maps on Alpha2LanguageCode values (e.g. "de", "en"), so the set must contain those codes.
 */
function streetMatch(span: Span, lang: string): SolutionMatch {
	return new SolutionMatch(span, {
		classification: "street",
		confidence: 1,
		languages: new Set([lang]),
	})
}

const basePenalty = 0.05

test("German (number-last): house number before street → penalty applied", () => {
	// "12 Hauptstraße" — number FIRST, which is wrong for German (a number-last language).
	const houseSpan = Span.from("12")
	houseSpan.start = 0
	houseSpan.end = 2

	const streetSpan = Span.from("Hauptstrasse")
	streetSpan.start = 3
	streetSpan.end = 15

	const houseNumber = new SolutionMatch(houseSpan, "house_number")
	const street = streetMatch(streetSpan, Alpha2LanguageCode.German)

	const solution = new Solution([houseNumber, street])
	const solutions = [solution]

	new HouseNumberPositionPenalty().solve({ solutions })

	expect(solution.penalty).toBeCloseTo(basePenalty)
})

test("German (number-last): house number after street → no penalty", () => {
	// "Hauptstraße 12" — number LAST, which is correct for German.
	const streetSpan = Span.from("Hauptstrasse")
	streetSpan.start = 0
	streetSpan.end = 12

	const houseSpan = Span.from("12")
	houseSpan.start = 13
	houseSpan.end = 15

	const street = streetMatch(streetSpan, Alpha2LanguageCode.German)
	const houseNumber = new SolutionMatch(houseSpan, "house_number")

	const solution = new Solution([street, houseNumber])
	const solutions = [solution]

	new HouseNumberPositionPenalty().solve({ solutions })

	expect(solution.penalty).toStrictEqual(0)
})

test("English (number-first): street before house number → penalty applied", () => {
	// "Main Street 12" — number LAST, which is wrong for English (a number-first language).
	const streetSpan = Span.from("Main Street")
	streetSpan.start = 0
	streetSpan.end = 11

	const houseSpan = Span.from("12")
	houseSpan.start = 12
	houseSpan.end = 14

	const street = streetMatch(streetSpan, Alpha2LanguageCode.English)
	const houseNumber = new SolutionMatch(houseSpan, "house_number")

	const solution = new Solution([street, houseNumber])
	const solutions = [solution]

	new HouseNumberPositionPenalty().solve({ solutions })

	expect(solution.penalty).toBeCloseTo(basePenalty)
})

test("English (number-first): house number before street → no penalty", () => {
	// "12 Main Street" — number FIRST, which is correct for English.
	const houseSpan = Span.from("12")
	houseSpan.start = 0
	houseSpan.end = 2

	const streetSpan = Span.from("Main Street")
	streetSpan.start = 3
	streetSpan.end = 14

	const houseNumber = new SolutionMatch(houseSpan, "house_number")
	const street = streetMatch(streetSpan, Alpha2LanguageCode.English)

	const solution = new Solution([houseNumber, street])
	const solutions = [solution]

	new HouseNumberPositionPenalty().solve({ solutions })

	expect(solution.penalty).toStrictEqual(0)
})

test("Spanish (half penalty): number-first position incurs basePenalty / 2", () => {
	// Spanish is in the number-LAST map but at half magnitude. "12 Calle Mayor" — number first.
	const houseSpan = Span.from("12")
	houseSpan.start = 0
	houseSpan.end = 2

	const streetSpan = Span.from("Calle Mayor")
	streetSpan.start = 3
	streetSpan.end = 14

	const houseNumber = new SolutionMatch(houseSpan, "house_number")
	const street = streetMatch(streetSpan, Alpha2LanguageCode.Spanish)

	const solution = new Solution([houseNumber, street])
	const solutions = [solution]

	new HouseNumberPositionPenalty().solve({ solutions })

	expect(solution.penalty).toBeCloseTo(basePenalty / 2)
})

test("no street language: solver leaves penalty untouched", () => {
	const houseSpan = Span.from("12")
	houseSpan.start = 0
	houseSpan.end = 2

	const streetSpan = Span.from("Main Street")
	streetSpan.start = 3
	streetSpan.end = 14

	const houseNumber = new SolutionMatch(houseSpan, "house_number")
	// Plain-string match → no `languages` set, so the solver skips it.
	const street = new SolutionMatch(streetSpan, "street")

	const solution = new Solution([houseNumber, street])
	const solutions = [solution]

	new HouseNumberPositionPenalty().solve({ solutions })

	expect(solution.penalty).toStrictEqual(0)
})

test("missing house number: solver leaves penalty untouched", () => {
	const streetSpan = Span.from("Hauptstrasse")
	streetSpan.start = 0
	streetSpan.end = 12

	const street = streetMatch(streetSpan, Alpha2LanguageCode.German)

	const solution = new Solution([street])
	const solutions = [solution]

	new HouseNumberPositionPenalty().solve({ solutions })

	expect(solution.penalty).toStrictEqual(0)
})

test("multi-language street: solver does not penalize ambiguous entries", () => {
	// "12 Rue" with two languages — the solver only handles single-language streets.
	const houseSpan = Span.from("12")
	houseSpan.start = 0
	houseSpan.end = 2

	const streetSpan = Span.from("Hauptstrasse")
	streetSpan.start = 3
	streetSpan.end = 15

	const houseNumber = new SolutionMatch(houseSpan, "house_number")
	const street = new SolutionMatch(streetSpan, {
		classification: "street",
		confidence: 1,
		languages: new Set([Alpha2LanguageCode.German, Alpha2LanguageCode.English]),
	})

	const solution = new Solution([houseNumber, street])
	const solutions = [solution]

	new HouseNumberPositionPenalty().solve({ solutions })

	expect(solution.penalty).toStrictEqual(0)
})
