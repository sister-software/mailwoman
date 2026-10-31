/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { expect, test } from "vitest"

import { codeShaped, contestedCodes, regionCodeCounts } from "./token.ts"

const row = (tokens: string[], labels: string[]) => ({ tokens, labels })

test("a code is two ASCII uppercase letters", () => {
	expect(codeShaped("NL")).toBe(true)

	for (const token of ["nl", "NLD", "N1", "ÉÉ"]) {
		expect(codeShaped(token)).toBe(false)
	}
})

test("a code is counted under the tag it opens", () => {
	const counts = regionCodeCounts([
		row(
			["Gander,", "NL", "A1V", "0A9,", "Canada"],
			["B-locality", "B-region", "B-postcode", "I-postcode", "B-country"]
		),
		row(["Amsterdam,", "NL"], ["B-locality", "B-country"]),
	])

	expect(Object.fromEntries(counts.get("NL")!)).toEqual({ region: 1, country: 1 })
})

test("a code inside a longer span is not an attestation", () => {
	expect(regionCodeCounts([row(["Cafe", "NL"], ["B-venue", "I-venue"])]).size).toBe(0)
})

test("contested codes carry both readings, worst first", () => {
	const rows = [
		...Array.from({ length: 10 }, () => row(["Amsterdam,", "NL"], ["B-locality", "B-country"])),
		row(["Gander,", "NL"], ["B-locality", "B-region"]),
		...Array.from({ length: 2 }, () => row(["Lima,", "PE"], ["B-locality", "B-country"])),
		row(["Charlottetown,", "PE"], ["B-locality", "B-region"]),
		row(["Vancouver,", "BC"], ["B-locality", "B-region"]),
	]

	expect(contestedCodes(regionCodeCounts(rows))).toEqual([
		["NL", 10, 1],
		["PE", 2, 1],
	])
})
