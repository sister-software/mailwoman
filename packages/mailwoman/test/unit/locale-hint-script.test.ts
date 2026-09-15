/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The locale hint names the SCRIPT each board row is written in, separately from its language.
 *
 *   `locale` is one BCP-47 tag and the folded character class buckets Kana, Han and Hangul as one `cjk` value, so
 *   `서울특별시 종로구` and `東京都千代田区` were the same input as far as anything downstream could tell and both answered
 *   `ja-JP` (#2282). `LocaleHint.script` carries the distinction; `locale` keeps its values, which is what these assert
 *   — a row's script is stated and its language label is left alone.
 *
 *   The population is the committed regression board rather than a list, so the assertion follows the board as it
 *   grows. What the board does not hold, this file says rather than skips: there are no Hangul-led rows on it today,
 *   and the `cases/kr/` directory that would supply them is an open box on #2277.
 */

import { detectLocale } from "@mailwoman/locale-hint"
import { computeQueryShape } from "@mailwoman/query-shape"
import { loadRegressionCases } from "mailwoman/eval-harness/gauntlet/cases/load"
import { describe, expect, it } from "vitest"

const cases = await loadRegressionCases()

/**
 * The scripts the hint reports for a row, most-written first.
 */
const scriptsOf = (input: string): ReadonlyArray<{ script: string; confidence: number }> =>
	detectLocale(computeQueryShape(input)).script ?? []

describe("the locale hint names each board row's script", () => {
	it("answers a script for all but the rows that carry no script-bearing character", () => {
		// A bare postcode names no script, and saying so is the right answer rather than folding it into a nearby one.
		const silent = cases.filter((c) => scriptsOf(c.input).length === 0)

		expect(silent.every((c) => !/\p{L}/u.test(c.input))).toBe(true)
	})

	it("reads Han off the ideographic rows without folding them into one CJK bucket", () => {
		const hanLed = cases.filter((c) => scriptsOf(c.input)[0]?.script === "Hani")

		// Thirteen today, across three countries — the fold this replaces could not have separated them from Kana or
		// Hangul rows, because it answered `cjk` for all three.
		expect(hanLed.length).toBeGreaterThanOrEqual(13)
		expect([...new Set(hanLed.map((c) => c.country))].toSorted()).toEqual(["CN", "JP", "SG"])
	})

	it("leaves `locale` alone on a row whose script it now names", () => {
		// The additive field is the whole point: a consumer mapping the hint to a weights package must see the label it
		// saw before, and a consumer that wants the script can read the script.
		for (const c of cases.filter((row) => scriptsOf(row.input)[0]?.script === "Hani")) {
			const hint = detectLocale(computeQueryShape(c.input))

			expect(hint.locale, c.id).toMatch(/^[a-z]{2}-[A-Z]{2}$/)
		}
	})

	it("names the Latin share of a mixed row beside its Han one", () => {
		// `mixed` named no script, so WHICH span carried the Han was unrecoverable. Both are reported now, ranked.
		const scripts = scriptsOf("金龍酒家, 12 Gerrard Street, London WC2H 7JS")

		expect(scripts.map((s) => s.script)).toEqual(["Latn", "Hani"])
		expect(scripts[0]!.confidence).toBeGreaterThan(scripts[1]!.confidence)
	})

	it("has no Hangul-led row to assert, and that is the board's gap rather than the hint's", () => {
		// `cases/kr/` is an open box on #2277. The hint answers `Hang` for Korean input; nothing on this board supplies
		// any, so this states the absence instead of asserting a number that would silently become wrong.
		expect(cases.filter((c) => scriptsOf(c.input)[0]?.script === "Hang")).toHaveLength(0)
		expect(scriptsOf("서울특별시 종로구")[0]?.script).toBe("Hang")
	})
})
