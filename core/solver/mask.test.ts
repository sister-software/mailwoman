/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { createMask } from "@mailwoman/core"
import { parser } from "mailwoman/test-kit"
import { expect, test } from "vitest"

const testCases: Array<[input: string, output: string]> = [
	[
		// ---
		"Kaschk Bar, Linienstraße 40 10119 Berlin",
		"VVVVVVVVVV  SSSSSSSSSSSS NN PPPPP AAAAAA",
	],

	[
		// ---
		"Foo Cafe 10 Main St London 10010 Earth",
		"VVVVVVVV NN SSSSSSS AAAAAA PPPPP      ",
	],

	[
		// ---
		"Lot 12/345 Illawarra Road Marrickville NSW 2204",
		"UUU UU NNN SSSSSSSSSSSSSS AAAAAAAAAAAA AAA PPPP",
	],
]

for (const [input, output] of testCases) {
	test("mask", async () => {
		const { context, solutions } = await parser.parse(input, { verbose: true })

		const [solution] = solutions

		if (!solution) {
			throw new Error(`No solution found for input: ${input}`)
		}

		expect(createMask(context, solution.matches)).toEqual(output)
	})
}
