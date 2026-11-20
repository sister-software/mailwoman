// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The postal-family answers of `acceptPostcode`, `countriesAcceptingPostcode`
 *   and `canComplete` against the frozen record taken before the per-country `RegExp` set
 *   and `PrefixAutomaton` were deleted.
 *
 *   The record holds the answers on libaddressinput's examples, every short string over the
 *   formats' alphabet, generated strings and real rows, and each input on which the removed
 *   implementation answered otherwise, with both answers and the issue 3088 defect that explains it.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { stringifyJSON } from "@mailwoman/core/json"
import { workspacePath } from "@mailwoman/core/paths"
import { describe, expect, it } from "vitest"

import { canComplete } from "#completion"
import { acceptPostcode, countriesAcceptingPostcode } from "#country-formats"

interface Frozen {
	accepting: Array<[input: string, countries: string, values: Array<[string, string]>]>
	completion: Array<{ country: string; alphabet: string; maxLength: number; probes: string[]; completable: string[] }>
	removedImplementationDifferences: Array<{
		fn: string
		input: string
		country?: string
		old: unknown
		new: unknown
		class: string
	}>
}

const frozen = await readLocalJSONFile<Frozen>(
	workspacePath("postcode", "data", "fixtures", "postal-syntax-frozen.fixture.json").toString()
)

/**
 * The strings of one country's completion record: the enumeration over its alphabet, and its probes.
 */
function completionStrings(entry: Frozen["completion"][number]): string[] {
	const strings = new Set<string>(["", ...entry.probes])
	let layer = [""]

	for (let length = 0; length < entry.maxLength; length++) {
		layer = layer.flatMap((prefix) => [...entry.alphabet].map((character) => prefix + character))

		for (const text of layer) {
			strings.add(text)
		}
	}

	return [...strings].toSorted()
}

describe("the frozen postal-family answers", () => {
	it("holds the accepting countries and the accepted value of every frozen input", () => {
		expect(frozen.accepting.length).toBeGreaterThan(10_000)

		for (const [input, countries, values] of frozen.accepting) {
			const accepting = countriesAcceptingPostcode(input)

			expect(accepting.join(","), stringifyJSON(input)).toBe(countries)

			for (const country of accepting) {
				const expected = values.find(([code]) => code === country)?.[1] ?? input.trim()

				expect(acceptPostcode(input, country), `${country} ${stringifyJSON(input)}`).toBe(expected)
			}
		}
	})

	it("holds the completable strings of every country", () => {
		for (const entry of frozen.completion) {
			const completable = completionStrings(entry).filter(
				(text) => canComplete(text, { countries: entry.country }).canComplete
			)

			expect(completable, entry.country).toEqual(entry.completable)
		}
	})

	it("answers as the engine does where the removed implementation answered otherwise", () => {
		expect(frozen.removedImplementationDifferences.length).toBeGreaterThan(0)

		for (const difference of frozen.removedImplementationDifferences) {
			const label = `${difference.fn} ${difference.country ?? ""} ${stringifyJSON(difference.input)}`

			if (difference.fn === "countriesAcceptingPostcode") {
				expect(countriesAcceptingPostcode(difference.input), label).toEqual(difference.new)
			} else if (difference.fn === "acceptPostcode") {
				expect(acceptPostcode(difference.input, difference.country!), label).toEqual(difference.new)
			} else if (difference.fn === "canComplete") {
				expect(canComplete(difference.input, { countries: difference.country! }).syntax, label).toEqual(difference.new)
			} else if (difference.fn === "canCompleteAll") {
				expect(
					canComplete(difference.input).syntax.map(({ country }) => country),
					label
				).toEqual(difference.new)
			}
		}
	})
})
