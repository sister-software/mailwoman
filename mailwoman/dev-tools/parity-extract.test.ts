/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { expect, test } from "vitest"

import { extractAssertCalls } from "./parity-extract.ts"

const SAMPLE = `
import { assert } from "mailwoman/test-kit"

assert(
	"wrigley field",
	{
		street: ["wrigley field"],
	},
	{
		venue: ["wrigley field"],
	}
)

assert(
	// ---
	"E Cesar Chavez St",
	{
		street: ["E Cesar Chavez St"],
	}
)

assert("no expectations means no solutions")
`

test("extractAssertCalls: literal inputs + expected records, in file order", () => {
	const cases = extractAssertCalls(SAMPLE, "mailwoman/test/address.usa.test.ts")

	expect(cases).toEqual([
		{
			file: "mailwoman/test/address.usa.test.ts",
			input: "wrigley field",
			expected: [{ street: ["wrigley field"] }, { venue: ["wrigley field"] }],
		},
		{
			file: "mailwoman/test/address.usa.test.ts",
			input: "E Cesar Chavez St",
			expected: [{ street: ["E Cesar Chavez St"] }],
		},
		{
			file: "mailwoman/test/address.usa.test.ts",
			input: "no expectations means no solutions",
			expected: [],
		},
	])
})

test("extractAssertCalls: non-literal expected args are recorded as source text and flagged", () => {
	const source = `assert("x", someHelper("y"))`
	const cases = extractAssertCalls(source, "f.test.ts")

	expect(cases).toEqual([{ file: "f.test.ts", input: "x", expected: [`someHelper("y")`], nonLiteral: true }])
})
