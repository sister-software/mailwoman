// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { createMask } from "mailwoman/core"
import { parser } from "mailwoman/sdk/test"
import test from "tape"

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
	test("mask", async (t) => {
		const { context, solutions } = await parser.parse(input, { verbose: true })

		const [solution] = solutions

		if (!solution) {
			t.fail("No solution found")
			t.end()

			return
		}

		t.equal(createMask(context, solution.matches), output)
		t.end()
	})
}
