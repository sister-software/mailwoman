// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, it } from "vitest"

import { fstForParse, parsePairPrior } from "#classifier/parse-country"
import type { FSTMatcherLike } from "#fst-prior"
import { LOCALE_COUNTRIES } from "#labels"
import type { PlacetypePairPriorOpts } from "#placetype/pair-prior"

/**
 * Locale logits that read `country` at softmax probability near `probability`.
 */
function headReading(country: (typeof LOCALE_COUNTRIES)[number], probability: number): number[] {
	const others = LOCALE_COUNTRIES.length - 1
	const lead = Math.log(probability / ((1 - probability) / others))

	return LOCALE_COUNTRIES.map((code) => (code === country ? lead : 0))
}

const pairIndexOf = (country: string): PlacetypePairPriorOpts => ({ index: { country, probe: () => null } })

const US_PAIRS = pairIndexOf("us")

describe("parsePairPrior", () => {
	it("applies every index when the setting is off, whatever the head reads", () => {
		expect(parsePairPrior(US_PAIRS, {}, headReading("FR", 0.99))).toBe(US_PAIRS)
	})

	it("refuses the US index on a row the head reads as another country and no caller states one (LB `Mount Lebanon, Lebanon`)", () => {
		const unstated = { pairIndexOwnCountry: { declaredCountry: null } }

		expect(parsePairPrior(US_PAIRS, unstated, headReading("FR", 0.95))).toBeUndefined()
	})

	it("refuses the index when the head is unsure and no caller states a country", () => {
		const unstated = { pairIndexOwnCountry: { declaredCountry: null } }

		expect(parsePairPrior(US_PAIRS, unstated, headReading("US", 0.5))).toBeUndefined()
		expect(parsePairPrior(US_PAIRS, unstated, headReading("US", 0.95))).toBe(US_PAIRS)
	})

	it("lets a stated country decide over the head, so a country outside the head's nine keeps its own index", () => {
		const nz = pairIndexOf("nz")

		expect(parsePairPrior(nz, { pairIndexOwnCountry: { declaredCountry: "NZ" } }, headReading("GB", 0.99))).toBe(nz)

		expect(
			parsePairPrior(US_PAIRS, { pairIndexOwnCountry: { declaredCountry: "lb" } }, headReading("US", 0.99))
		).toBeUndefined()
	})
})

/**
 * An FST whose every walk returns null, told apart from another by identity.
 */
const emptyFST = (): FSTMatcherLike => ({ walk: () => null, walkFrom: () => null, accepting: () => [] })

describe("fstForParse", () => {
	const usFST = emptyFST()
	const gbFST = emptyFST()
	const shipped = (country: string) => (country === "GB" ? gbFST : null)

	it("routes a row the head reads as GB to the GB FST (`Kensington, London` under en-US)", async () => {
		expect(await fstForParse({ fst: usFST, fstForCountry: shipped }, headReading("GB", 0.99))).toBe(gbFST)
	})

	it("keeps the session FST when the head reads a country that ships none, or reads none confidently", async () => {
		expect(await fstForParse({ fst: usFST, fstForCountry: shipped }, headReading("CA", 0.99))).toBe(usFST)
		expect(await fstForParse({ fst: usFST, fstForCountry: shipped }, headReading("GB", 0.5))).toBe(usFST)
		expect(await fstForParse({ fst: usFST, fstForCountry: shipped }, null)).toBe(usFST)
	})

	it("feeds no FST when the parse has none, so routing never turns the prior on", async () => {
		expect(await fstForParse({ fstForCountry: shipped }, headReading("GB", 0.99))).toBeNull()
	})

	it("is the session FST without a lookup", async () => {
		expect(await fstForParse({ fst: usFST }, headReading("GB", 0.99))).toBe(usFST)
	})
})
