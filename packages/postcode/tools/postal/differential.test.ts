// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { resolvePackageDirectory } from "@mailwoman/core/module/resolvers"
import { describe, expect, it } from "vitest"

import { countriesAcceptingPostcode, postcodeSyntaxCountries } from "#country-formats"
import { acceptingCountries } from "#recognize"
import {
	DENSE_ALPHABET,
	compareAccepting,
	postalRecognizer,
	compareAll,
	enumerateStrings,
	probeInputs,
	randomStrings,
} from "#tools/postal/differential"

/**
 * The libaddressinput examples of every country, as `completion.test.ts` reads them.
 */
async function readExamples(): Promise<string[]> {
	const dir = resolvePackageDirectory("@mailwoman/dictionaries")("data", "chromium-i18n", "ssl-address")
	const examples: string[] = []

	for (const country of postcodeSyntaxCountries()) {
		const metadata = await readLocalJSONFile<{ readonly zipex?: string }>(dir(`${country}.json`))

		examples.push(...(metadata.zipex ? metadata.zipex.split(",") : []))
	}

	return examples
}

describe("acceptingCountries against countriesAcceptingPostcode", () => {
	it("agrees on every country's own examples and on inputs built to probe the digit and case rules", async () => {
		const examples = await readExamples()
		const { compared, differences } = compareAll([...examples, ...probeInputs(examples)])

		expect(compared).toBeGreaterThan(2000)
		expect(differences).toEqual([])
	})

	it("agrees on every string up to five characters over the characters the formats are written in", () => {
		const { compared, differences } = compareAll(enumerateStrings([..."019A -"], 5))

		expect(compared).toBe(1 + 6 + 36 + 216 + 1296 + 7776)
		expect(differences).toEqual([])
	})

	it("agrees on generated strings dense in digits, letters, spaces and hyphens", () => {
		const { differences } = compareAll(randomStrings(DENSE_ALPHABET, 4000, 12, 6_000_001))

		expect(differences).toEqual([])
	})

	it("holds the digit and case rules, and the probes are not vacuous", () => {
		// JavaScript's `iu` folds the Kelvin sign to `k` and the long s to `s`, and its `\d` is ASCII only.
		expect(countriesAcceptingPostcode("K1A 0B1")).toContain("CA")
		expect(compareAccepting("K1A 0B1")).toBeNull()
		expect(acceptingCountries(postalRecognizer, "K1A 0B1")).toContain("CA")
		expect(acceptingCountries(postalRecognizer, "ſſ 1000")).toEqual(countriesAcceptingPostcode("ſſ 1000"))
		expect(acceptingCountries(postalRecognizer, "１２３４５")).toEqual([])
		expect(acceptingCountries(postalRecognizer, "١٢٣٤")).toEqual([])
		expect(acceptingCountries(postalRecognizer, "12345́")).toEqual([])
		// The printed prefix is matched by `toUpperCase`, which maps the long s to `S` and the dotless i to `I`.
		expect(countriesAcceptingPostcode("ſı-2000")).toContain("SI")
		expect(compareAccepting("ſı-2000")).toBeNull()
	})

	it("agrees on Bahrain's four digits and refuses what its boundary assertions would refuse", () => {
		for (const input of ["1000", "1299", "9999", "1300", "0999", "100", "10000", " 1200 "]) {
			expect(compareAccepting(input), input).toBeNull()
		}
	})

	it("lists the one known difference: a ligature in a printed prefix that acceptPostcode reads wrongly", () => {
		// `acceptPostcode` tests `trimmed.toUpperCase().startsWith("FI-")`, which the
		// ligature U+FB01 satisfies because it upper-cases to `FI`.
		// It then removes `prefix.length` code units from the original text
		// and drops one more digit than the prefix covers.
		// The text is no Finnish postcode, and the family doesn't reproduce that read.
		// The defect is in country-formats.ts and is listed here and not fixed.
		expect(compareAccepting("ﬁ-123456")).toEqual({
			input: "ﬁ-123456",
			expected: ["FI"],
			recognized: [],
		})

		expect(compareAccepting("ﬁ-12345")).toBeNull()
	})

	it("agrees on the printed forms of every prefixed country", () => {
		const forms = [
			"〒100-0001",
			"〒1000001",
			"L-1234",
			"l- 1234",
			"AZ 1000",
			"az  1000",
			"AZ1000",
			"FO100",
			"FL-9490",
			"fl-9490",
		]

		expect(compareAll(forms).differences).toEqual([])
	})
})
