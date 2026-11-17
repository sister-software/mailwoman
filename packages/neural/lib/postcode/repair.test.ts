// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import type { BIOLabel } from "@mailwoman/codex/component"
import type { DecoderToken } from "@mailwoman/core/decoder"
import { describe, expect, it } from "vitest"

import { repairPostcodeLabels } from "#postcode"

function tok(piece: string, start: number, end: number, label: BIOLabel): DecoderToken {
	return { piece, start, end, label, confidence: 1 }
}

function postcodeValue(text: string, tokens: DecoderToken[]): string | null {
	let start = -1
	let end = -1

	for (const t of tokens) {
		if (t.label === "B-postcode") {
			if (start === -1) {
				start = t.start
				end = t.end
			}
		} else if (t.label === "I-postcode" && start !== -1) {
			end = t.end
		} else if (start !== -1) {
			break
		}
	}

	return start === -1 ? null : text.slice(start, end)
}

function localityValue(text: string, tokens: DecoderToken[]): string | null {
	let start = -1
	let end = -1

	for (const t of tokens) {
		if (t.label === "B-locality") {
			if (start === -1) {
				start = t.start
				end = t.end
			} else break
		} else if (t.label === "I-locality" && start !== -1) {
			end = t.end
		} else if (start !== -1) {
			break
		}
	}

	return start === -1 ? null : text.slice(start, end)
}

describe("repairPostcodeLabels", () => {
	it("ADDs an alphanumeric postcode the model missed (GB), over O/locality", () => {
		const text = "London SW1A 1AA"

		const tokens = [tok("London", 0, 6, "B-locality"), tok("SW1A", 7, 11, "O"), tok("1AA", 12, 15, "O")]
		const { tokens: out, changed } = repairPostcodeLabels(text, tokens)
		expect(changed).toBeGreaterThan(0)
		expect(postcodeValue(text, out)).toBe("SW1A 1AA")
	})

	it("SNAPs a fragmented IE Eircode to the full shape (F91 Y5CY — the 2026-07-06 diagnostic)", () => {
		const text = "Ballysadare, F91 Y5CY"

		const tokens = [
			tok("Ballysadare", 0, 11, "B-locality"),
			tok(",", 11, 12, "O"),
			tok("F", 13, 14, "O"),
			tok("91", 14, 16, "B-postcode"),
			tok("Y5CY", 17, 21, "O"),
		]

		const { tokens: out } = repairPostcodeLabels(text, tokens)
		expect(postcodeValue(text, out)).toBe("F91 Y5CY")
	})

	it("ADDs a missed IE Eircode over O, incl. the D6W special; GB inward stays GB-shaped", () => {
		const text = "Dublin D6W XV67"
		const tokens = [tok("Dublin", 0, 6, "B-locality"), tok("D6W", 7, 10, "O"), tok("XV67", 11, 15, "O")]
		const { tokens: out } = repairPostcodeLabels(text, tokens)
		expect(postcodeValue(text, out)).toBe("D6W XV67")

		const gb = "Birmingham B12 8QX"
		const gbTokens = [tok("Birmingham", 0, 10, "B-locality"), tok("B12", 11, 14, "O"), tok("8QX", 15, 18, "O")]
		const { tokens: gbOut } = repairPostcodeLabels(gb, gbTokens)
		expect(postcodeValue(gb, gbOut)).toBe("B12 8QX")
	})

	it("SNAPs a truncated postcode to the full shape (CA M5V 2T6)", () => {
		const text = "Toronto ON M5V 2T6"

		const tokens = [
			tok("Toronto", 0, 7, "B-locality"),
			tok("ON", 8, 10, "B-region"),
			tok("M5V", 11, 14, "O"),
			tok("2T6", 15, 18, "B-postcode"),
		]

		const { tokens: out } = repairPostcodeLabels(text, tokens)
		expect(postcodeValue(text, out)).toBe("M5V 2T6")
	})

	it("Longest-match-wins: US ZIP+4 beats the NL-shaped tail (94610-2737 CA → not 2737 CA)", () => {
		const text = "Oakland 94610-2737 CA"

		const tokens = [
			tok("Oakland", 0, 7, "B-locality"),
			tok("94610-2737", 8, 18, "B-postcode"),
			tok("CA", 19, 21, "B-region"),
		]

		const { tokens: out } = repairPostcodeLabels(text, tokens)
		expect(postcodeValue(text, out)).toBe("94610-2737")

		expect(out.find((t) => t.piece === "CA")!.label).not.toBe("I-postcode")
	})

	it("Keeps a BR CEP whole: NNNNN-NNN is a shape, not a 5-digit postcode with a stray tail", () => {
		const text = "Caxias do Sul, RS 95090-020, Brazil"

		const tokens = [
			tok("Caxias do Sul", 0, 13, "B-locality"),
			tok(",", 13, 14, "O"),
			tok("RS", 15, 17, "B-region"),
			tok("95090", 18, 23, "B-postcode"),
			tok("-", 23, 24, "I-postcode"),
			tok("020", 24, 27, "I-postcode"),
			tok(",", 27, 28, "O"),
			tok("Brazil", 29, 35, "B-country"),
		]

		const { tokens: out } = repairPostcodeLabels(text, tokens)
		expect(postcodeValue(text, out)).toBe("95090-020")
	})

	it("SNAPs a fragmented BR CEP back to the full shape", () => {
		const text = "Brasília - Federal District, 70390-100, Brazil"

		const tokens = [
			tok("Brasília", 0, 8, "B-locality"),
			tok(" - ", 8, 11, "O"),
			tok("Federal District", 11, 27, "B-region"),
			tok(",", 27, 28, "O"),
			tok("70390", 29, 34, "B-postcode"),
			tok("-", 34, 35, "O"),
			tok("100", 35, 38, "B-locality"),
			tok(",", 38, 39, "O"),
			tok("Brazil", 40, 46, "B-country"),
		]

		const { tokens: out } = repairPostcodeLabels(text, tokens)
		expect(postcodeValue(text, out)).toBe("70390-100")
	})

	it("does not let the BR shape steal the tail of a US ZIP+4", () => {
		const text = "Oakland 94610-2737"
		const tokens = [tok("Oakland", 0, 7, "B-locality"), tok("94610-2737", 8, 18, "B-postcode")]
		const { tokens: out } = repairPostcodeLabels(text, tokens)
		expect(postcodeValue(text, out)).toBe("94610-2737")
	})

	it("still refuses to CREATE a BR-shaped postcode — numeric shapes stay SNAP-only", () => {
		const text = "12345-678 Main St"

		const tokens = [
			tok("12345-678", 0, 9, "B-house_number"),
			tok("Main", 10, 14, "B-street"),
			tok("St", 15, 17, "I-street"),
		]

		const { tokens: out, changed } = repairPostcodeLabels(text, tokens)
		expect(changed).toBe(0)
		expect(postcodeValue(text, out)).toBeNull()
	})

	it("clips smear: postcode label bleeding onto a neighbor is trimmed to the match", () => {
		const text = "Paris 75008 France"

		const tokens = [
			tok("Paris", 0, 5, "B-locality"),
			tok("75008", 6, 11, "B-postcode"),
			tok("France", 12, 18, "I-postcode"),
		]

		const { tokens: out } = repairPostcodeLabels(text, tokens)
		expect(postcodeValue(text, out)).toBe("75008")
		expect(out.find((t) => t.piece === "France")!.label).toBe("O")
	})

	it("Hands a trailing over-extension BACK to the city (DE postcode→city absorption)", () => {
		const text = "08523 Plauen"

		const tokens = [tok("08523", 0, 5, "B-postcode"), tok("Pl", 6, 8, "I-postcode"), tok("auen", 8, 12, "B-locality")]

		const { tokens: out } = repairPostcodeLabels(text, tokens)
		expect(postcodeValue(text, out)).toBe("08523")

		expect(localityValue(text, out)).toBe("Plauen")
	})

	it("does NOT add a numeric postcode from scratch (a bare 5-digit could be a house number)", () => {
		const text = "12345 Main St"

		const tokens = [tok("12345", 0, 5, "B-house_number"), tok("Main", 6, 10, "B-street"), tok("St", 11, 13, "I-street")]
		const { tokens: out, changed } = repairPostcodeLabels(text, tokens)
		expect(changed).toBe(0)
		expect(postcodeValue(text, out)).toBeNull()
	})

	it("does NOT add over a structural tag even for an alphanumeric shape", () => {
		const text = "1012 AB"

		const tokens = [tok("1012", 0, 4, "B-house_number"), tok("AB", 5, 7, "O")]
		const { tokens: out } = repairPostcodeLabels(text, tokens)
		expect(out[0]!.label).toBe("B-house_number")
	})

	it("is a no-op when no postcode shape is present", () => {
		const text = "Main Street Springfield"

		const tokens = [
			tok("Main", 0, 4, "B-street"),
			tok("Street", 5, 11, "I-street"),
			tok("Springfield", 12, 23, "B-locality"),
		]

		const { tokens: out, changed } = repairPostcodeLabels(text, tokens)
		expect(changed).toBe(0)
		expect(out.map((t) => t.label)).toEqual(tokens.map((t) => t.label))
	})
})

function charTokens(spans: readonly (readonly [string, string | null])[]): { text: string; tokens: DecoderToken[] } {
	const tokens: DecoderToken[] = []
	let text = ""

	for (const [surface, tag] of spans) {
		for (const [k, ch] of [...surface].entries()) {
			const label = (tag ? (k === 0 ? `B-${tag}` : `I-${tag}`) : "O") as BIOLabel

			tokens.push(tok(ch, text.length, text.length + ch.length, label))
			text += ch
		}
	}

	return { text, tokens }
}

describe("a postcode designated by the JP postal mark", () => {
	it("overwrites a house_number the model put on the digits behind 〒, leaving the mark outside", () => {
		const { text, tokens } = charTokens([
			["りんりん, ", null],
			["〒", null],
			["506-0025", "house_number"],
			[" ", null],
			["岐阜県", "prefecture"],
			["高山市", "municipality"],
			["天満町", "district"],
			["3丁目", "block"],
			[" 57", null],
		])

		const result = repairPostcodeLabels(text, tokens)

		expect(postcodeValue(text, result.tokens)).toBe("506-0025")
		expect(result.tokens.find((t) => t.piece === "〒")?.label).toBe("O")
		expect(result.tokens.some((t) => t.label.endsWith("house_number"))).toBe(false)
		expect(result.tokens.filter((t) => t.label === "B-prefecture" || t.label === "B-district")).toHaveLength(2)
	})

	describe("under a card that declares span_mode postal", () => {
		const text = "London sw1a 2aa"

		const tokens = (): DecoderToken[] => [
			tok("London", 0, 6, "B-locality"),
			tok(" sw1a", 6, 11, "B-postcode"),
			tok(" 2aa", 11, 15, "B-locality"),
		]

		it("reads the postal family, which matches a lower-case code the frozen table leaves alone", () => {
			expect(repairPostcodeLabels(text, tokens()).changed).toBe(0)

			const result = repairPostcodeLabels(text, tokens(), "postal")

			expect(postcodeValue(text, result.tokens)?.trim()).toBe("sw1a 2aa")
		})

		it("refuses a candidate with no digit, so a word is no postcode", () => {
			const word = "Toronto Road"
			const labeled = [tok("Toronto", 0, 7, "B-locality"), tok(" Road", 7, 12, "B-street")]

			expect(repairPostcodeLabels(word, labeled, "postal").changed).toBe(0)
		})
	})

	describe("the rows that a postal card regressed against model 10.8.0's shaped card", () => {
		/**
		 * Tokens over `text`, one per listed surface, located left to right, with the labels
		 * the shipped model decoded for the board or held-out row before the repair ran.
		 */
		function labeled(text: string, spans: readonly (readonly [string, BIOLabel])[]): DecoderToken[] {
			let from = 0

			return spans.map(([surface, label]) => {
				const start = text.indexOf(surface, from)

				if (start === -1) throw new Error(`${surface} is not in ${text} after ${from}`)
				from = start + surface.length

				return tok(surface, start, from, label)
			})
		}

		const labelOf = (tokens: readonly DecoderToken[], piece: string) => tokens.find((t) => t.piece === piece)?.label

		it("leaves a US state code outside the ZIP code", () => {
			const text = "4900 Airport Pkwy, Addison TX 75001"

			const tokens = labeled(text, [
				["4900", "B-house_number"],
				["Airport", "B-street"],
				["Pkwy", "B-street_suffix"],
				[",", "O"],
				["Addison", "B-locality"],
				["TX", "B-region"],
				["75001", "B-postcode"],
			])

			for (const country of [null, "US"]) {
				const out = repairPostcodeLabels(text, tokens, "postal", country).tokens

				expect(postcodeValue(text, out)).toBe("75001")
				expect(labelOf(out, "TX")).toBe("B-region")
			}
		})

		it("leaves a region the model decoded in place before a ZIP code", () => {
			const text = "Alameda, CA 94501"

			const tokens = labeled(text, [
				["Alameda", "B-locality"],
				[",", "O"],
				["CA", "B-region"],
				["94501", "B-postcode"],
			])

			const out = repairPostcodeLabels(text, tokens, "postal", "US").tokens

			expect(postcodeValue(text, out)).toBe("94501")
			expect(labelOf(out, "CA")).toBe("B-region")
		})

		it("keeps the printed country prefix the model labeled as part of a Swedish code", () => {
			const text = "Isak Health Clinic AB, Vinkelgatan 2, SE-235 36 Vellinge"

			const tokens = labeled(text, [
				["2", "B-house_number"],
				[",", "O"],
				["SE", "B-postcode"],
				["-", "I-postcode"],
				["235", "I-postcode"],
				["36", "B-postcode"],
				["Vellinge", "B-locality"],
			])

			expect(postcodeValue(text, repairPostcodeLabels(text, tokens, "postal").tokens)).toBe("SE-235 36")
		})

		it("keeps the printed prefix of a Faroese code", () => {
			const text = "Norðurhædd 62, FO600 Saltangará"

			const tokens = labeled(text, [
				["62", "B-house_number"],
				[",", "O"],
				["FO", "B-postcode"],
				["600", "I-postcode"],
				["Saltangará", "B-locality"],
			])

			expect(postcodeValue(text, repairPostcodeLabels(text, tokens, "postal").tokens)).toBe("FO600")
		})

		it("never runs a Swiss code into the locality after it", () => {
			const text = "Kirchstrasse 27, CH-6454 Flüelen"

			const tokens = labeled(text, [
				["Kirchstrasse", "B-street"],
				["27", "B-house_number"],
				[",", "O"],
				["CH", "O"],
				["-", "O"],
				["6454", "B-postcode"],
				["F", "B-locality"],
				["lü", "I-locality"],
				["elen", "I-locality"],
			])

			const out = repairPostcodeLabels(text, tokens, "postal").tokens

			expect(postcodeValue(text, out)).toBe("6454")
			expect(localityValue(text, out)).toBe("Flüelen")
		})

		it("adds a Singapore code written in its S( ) mark", () => {
			const text = "77A Neil Road S(088903)"

			const tokens = labeled(text, [
				["77A", "B-house_number"],
				["Neil", "B-street"],
				["Road", "B-street_suffix"],
				["S", "O"],
				["(", "O"],
				["088903", "O"],
				[")", "O"],
			])

			expect(postcodeValue(text, repairPostcodeLabels(text, tokens, "postal", "US").tokens)).toBe("088903")
		})

		it("refuses a bare code whose countries exclude the row's country", () => {
			const text = "Dublin D6W XV67"
			const tokens = [tok("Dublin", 0, 6, "B-locality"), tok("D6W", 7, 10, "O"), tok("XV67", 11, 15, "O")]

			expect(postcodeValue(text, repairPostcodeLabels(text, tokens, "postal", "IE").tokens)).toBe("D6W XV67")
			expect(repairPostcodeLabels(text, tokens, "postal", "FR").changed).toBe(0)
		})
	})

	it("leaves the same digits alone without the mark: a numeric shape never overwrites a house number", () => {
		const { text, tokens } = charTokens([
			["506-0025", "house_number"],
			[" ", null],
			["岐阜県", "prefecture"],
			["高山市", "municipality"],
		])

		const result = repairPostcodeLabels(text, tokens)

		expect(result.changed).toBe(0)
		expect(postcodeValue(text, result.tokens)).toBeNull()
	})
})
