// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, it } from "vitest"

import { fstForParse, pairIndexAppliesTo } from "#classifier/parse-country"
import type { FSTMatcherLike } from "#fst-prior"
import { LOCALE_COUNTRIES } from "#labels"

/**
 * Locale logits that read `country` at softmax probability near `probability`.
 */
function headReading(country: (typeof LOCALE_COUNTRIES)[number], probability: number): number[] {
	const others = LOCALE_COUNTRIES.length - 1
	const lead = Math.log(probability / ((1 - probability) / others))

	return LOCALE_COUNTRIES.map((code) => (code === country ? lead : 0))
}

const US_INDEX = { country: "us" }

describe("pairIndexAppliesTo", () => {
	it("applies every index when the setting is off, whatever the head reads", () => {
		expect(pairIndexAppliesTo(US_INDEX, {}, headReading("FR", 0.99))).toBe(true)
	})

	it("refuses the US index on a row the head reads as another country and no caller states one (LB `Mount Lebanon, Lebanon`)", () => {
		const unstated = { pairIndexCountryGate: { declaredCountry: null } }

		expect(pairIndexAppliesTo(US_INDEX, unstated, headReading("FR", 0.95))).toBe(false)
	})

	it("refuses the index when the head is unsure and no caller states a country", () => {
		const unstated = { pairIndexCountryGate: { declaredCountry: null } }

		expect(pairIndexAppliesTo(US_INDEX, unstated, headReading("US", 0.5))).toBe(false)
		expect(pairIndexAppliesTo(US_INDEX, unstated, headReading("US", 0.95))).toBe(true)
	})

	it("lets a stated country decide over the head, so a country outside the head's nine keeps its own index", () => {
		const nz = { country: "nz" }

		expect(pairIndexAppliesTo(nz, { pairIndexCountryGate: { declaredCountry: "NZ" } }, headReading("GB", 0.99))).toBe(
			true
		)

		expect(
			pairIndexAppliesTo(US_INDEX, { pairIndexCountryGate: { declaredCountry: "lb" } }, headReading("US", 0.99))
		).toBe(false)
	})
})

describe("fstForParse", () => {
	const usFST = { name: "us" } as unknown as FSTMatcherLike
	const gbFST = { name: "gb" } as unknown as FSTMatcherLike
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
