// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { workspacePath } from "@mailwoman/core/paths"
import { createRecognizer } from "@mailwoman/recognize"
import { describe, expect, it } from "vitest"

import { postcodePrefix, postcodeSyntaxCountries } from "#country-formats"
import {
	acceptingCountries,
	postal,
	postalCandidates,
	postalCountries,
	postalCountryCodes,
	splitPrintedPostcode,
} from "#recognize/postal"
import { PostalMetadata } from "#recognize/postal.generated"
import { translateBody } from "#tools/postal/definition"

const recognizer = createRecognizer([postal])

describe("the postal family's shapes", () => {
	it("holds every country of the syntax table exactly once as a bare code", () => {
		const bare = Object.values(PostalMetadata.shapes).filter((shape) => shape.kind === "code")
		const listed = bare.flatMap((shape) => [...shape.countries]).toSorted()

		expect(listed).toEqual(postcodeSyntaxCountries())
	})

	it("holds a printed shape for each country whose layout prints a prefix, and only those", () => {
		const printed = Object.values(PostalMetadata.shapes).filter((shape) => shape.kind === "printed")
		const prefixed = postcodeSyntaxCountries().filter((country) => postcodePrefix(country))

		expect(printed.flatMap((shape) => [...shape.countries]).toSorted()).toEqual(prefixed)
	})

	it("groups countries that write the same code into one shape", () => {
		const sizes = Object.values(PostalMetadata.shapes)
			.filter((shape) => shape.kind === "code")
			.map((shape) => shape.countries.length)

		expect(Math.max(...sizes)).toBeGreaterThan(20)
		expect(sizes.length).toBeLessThan(postcodeSyntaxCountries().length / 2)
	})

	it("rewrites Bahrain's boundary groups to nothing and records the rewrite", () => {
		const rewrites: Parameters<typeof translateBody>[1] = []

		translateBody("BH", rewrites)

		expect(rewrites?.map(({ construct }) => construct)).toEqual(["(?:^|\\b)", "(?:$|\\b)"])
		expect(acceptingCountries(recognizer, "1299")).toContain("BH")
		expect(acceptingCountries(recognizer, "1300")).not.toContain("BH")
		expect(acceptingCountries(recognizer, "0999")).not.toContain("BH")
	})

	it("refuses no other country's pattern, and the translation holds no assertion", () => {
		for (const country of postcodeSyntaxCountries()) {
			expect(translateBody(country), country).not.toMatch(/[\^$]|\\b/u)
		}
	})
})

describe("a recognition's countries", () => {
	it("lists every country that writes five digits for a bare five-digit code", () => {
		const { recognitions } = recognizer.recognize("12345")
		const countries = new Set(recognitions.flatMap((recognition) => postalCountryCodes(recognition)))

		for (const country of ["DE", "FR", "ES", "IT", "MX", "US", "TR"]) {
			expect(countries.has(country), country).toBe(true)
		}

		expect(countries.has("GB")).toBe(false)
	})

	it("holds the codes a CountrySet cannot, beside the CountrySet", () => {
		const recognition = recognizer.recognize("ASCN 1ZZ").recognitions.find(({ kind }) => kind === "postal.ac")!

		expect([...postalCountryCodes(recognition)]).toEqual(["AC"])
		expect([...postalCountries(recognition)]).toEqual([])
		expect(() => postalCountries({ kind: "word.ascii" })).toThrow(TypeError)
	})

	it("equals countriesAcceptingPostcode for the postcodes people write", () => {
		expect(acceptingCountries(recognizer, "SW1A 1AA")).toEqual(["GB"])
		expect(acceptingCountries(recognizer, " 100-0001 ")).toEqual(["CR", "JP"])
		expect(acceptingCountries(recognizer, "〒100-0001")).toEqual(["JP"])
		expect(acceptingCountries(recognizer, "")).toEqual([])
	})
})

describe("an embedded candidate", () => {
	const candidatesOf = (text: string) => postalCandidates(recognizer.recognize(text).recognitions)

	it("reports 12345 Main Street's five digits with every country that writes five digits, and decides nothing", () => {
		const candidates = candidatesOf("12345 Main Street")
		const five = candidates.filter(({ text }) => text === "12345")

		expect(five.length).toBeGreaterThan(0)
		const named = five.flatMap(({ countries }) => [...countries].map((country) => String(country)))

		expect(named).toContain("US")
		expect(named).toContain("DE")
		// Every candidate is a candidate: there's no field that marks the text as a postcode.
		expect(Object.keys(five[0]!).toSorted()).toEqual(["countries", "end", "kind", "printed", "start", "text"])
	})

	it("drops a candidate inside a longer run of letters and digits, and keeps one beside punctuation", () => {
		expect(candidatesOf("123456").filter(({ text }) => text.length === 5)).toEqual([])
		expect(candidatesOf("12345-6789").some(({ text }) => text === "12345")).toBe(false)
		expect(candidatesOf("12345-6789").some(({ text }) => text === "12345-6789")).toBe(true)
		expect(candidatesOf("Main St, 12345.").some(({ text }) => text === "12345")).toBe(true)
		expect(candidatesOf("〒100-0001東京都").some(({ text }) => text === "〒100-0001")).toBe(true)
		expect(candidatesOf("a12345").filter(({ text }) => text === "12345")).toEqual([])
		expect(candidatesOf("12345").some(({ text }) => text === "12345")).toBe(true)
		// Another class of character bounds a candidate: an ideographic character and a fullwidth digit are no ASCII digit.
		expect(candidatesOf("東京12345東京").some(({ text }) => text === "12345")).toBe(true)
	})

	it("reports no candidate inside a long run of digits, so a digit run costs no more than its length", () => {
		expect(candidatesOf("1".repeat(300)).filter(({ end, start }) => end - start < 300)).toEqual([])
	})

	it("reports a two-part code with its space", () => {
		expect(candidatesOf("10 Downing St, London SW1A 2AA UK").some(({ text }) => text === "SW1A 2AA")).toBe(true)
	})
})

describe("a printed postcode", () => {
	it("separates the prefix from the code", () => {
		for (const [text, prefix, code, country] of [
			["〒100-0001", "〒", "100-0001", "JP"],
			["L-1234", "L-", "1234", "LU"],
			["AZ 1000", "AZ ", "1000", "AZ"],
			["az  1000", "az ", "1000", "AZ"],
		] as const) {
			const printed = recognizer
				.recognize(text)
				.recognitions.filter((recognition) => recognition.kind.startsWith("printed."))
				.map((recognition) => ({ recognition, split: splitPrintedPostcode(recognition) }))

			expect(printed, text).toHaveLength(1)
			expect(printed[0]!.split, text).toMatchObject({ prefix, code })
			expect([...postalCountryCodes(printed[0]!.recognition)], text).toEqual([country])
		}
	})

	it("states the relation to the bare shape: the printed code is a string of that shape", () => {
		for (const [shapeID, shape] of Object.entries(PostalMetadata.shapes)) {
			if (shape.kind !== "printed") continue

			const bare = PostalMetadata.shapes[shape.bare as keyof typeof PostalMetadata.shapes]

			expect(bare?.countries, shapeID).toContain(shape.countries[0])
		}
	})

	it("reads a bare shape as no printed postcode", () => {
		const bare = recognizer.recognize("12345").recognitions[0]!

		expect(splitPrintedPostcode(bare)).toBeNull()
	})
})

describe("the declared overlaps", () => {
	it("report both shapes on each pair's witness", async () => {
		const fixture = await readLocalJSONFile<{
			pairs: Array<{ a: { family: string; shape: string }; b: { family: string; shape: string }; witness: string }>
		}>(workspacePath("postcode", "data", "fixtures", "postal-overlap-witnesses.json").toString())

		const own = fixture.pairs.filter(({ a, b }) => a.family === "postal" && b.family === "postal")

		expect(own.length).toBeGreaterThan(100)

		for (const { a, b, witness } of own) {
			const kinds = new Set<string>(recognizer.recognize(witness).recognitions.map(({ kind }) => kind))

			expect(
				[a.shape, b.shape].every((shape) => kinds.has(shape)),
				`${a.shape} ${b.shape} ${witness}`
			).toBe(true)
		}
	})
})
