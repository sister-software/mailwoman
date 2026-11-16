// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The recognizer the pipeline reads gives every Unicode codepoint,
 *   as a one-codepoint text, the character class, token class, scripts, segment count
 *   and known-format count that the fixture froze from the legacy classifier.
 */

import { codepointKey, readFrozenFixture } from "@mailwoman/recognize/tools/frozen"
import { expect, it } from "vitest"

import { computeQueryShape } from "#recognize/query-shape"

it("equals the frozen output on every Unicode codepoint", { timeout: 600_000 }, async () => {
	const { codepointRuns } = await readFrozenFixture()
	const failures: Array<{ codepoint: string; expected: string; actual: string }> = []
	let checked = 0

	for (const [first, last, expected] of codepointRuns) {
		for (let codepoint = first; codepoint <= last; codepoint++) {
			const actual = codepointKey(computeQueryShape(String.fromCodePoint(codepoint)))

			checked++

			if (actual !== expected) {
				failures.push({ codepoint: codepoint.toString(16), expected, actual })
			}
		}
	}

	expect(checked).toBe(0x11_00_00)
	expect(failures.slice(0, 5)).toEqual([])
})
