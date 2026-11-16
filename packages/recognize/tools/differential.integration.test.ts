// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The `structure` family's declared codepoint classes and script ranges equal the legacy ranges.
 *
 *   Every codepoint from U+0000 to U+10FFFF, including each lone surrogate,
 *   goes through the family as a one-codepoint text, and its class, token class
 *   and scripts must match the runs the fixture froze from the legacy classifier.
 */

import { expect, it } from "vitest"

import { createRecognizer } from "#index"
import { structure } from "#structure"
import { codepointKey, readFrozenFixture } from "#tools/frozen"

const recognizer = createRecognizer([structure])

it("equals the frozen class and script of every Unicode codepoint", { timeout: 600_000 }, async () => {
	const { codepointRuns } = await readFrozenFixture()
	const failures: Array<{ codepoint: string; expected: string; actual: string }> = []
	let checked = 0

	for (const [first, last, frozenKey] of codepointRuns) {
		// The frozen key ends with the legacy known-format count.
		// This family doesn't fill that field.
		const expected = frozenKey.split("|").slice(0, -1).join("|")

		for (let codepoint = first; codepoint <= last; codepoint++) {
			const { fields } = recognizer.recognize(String.fromCodePoint(codepoint))

			const actual = codepointKey({ ...fields, knownFormats: [] })
				.split("|")
				.slice(0, -1)
				.join("|")

			checked++

			if (actual !== expected) {
				failures.push({ codepoint: codepoint.toString(16), expected, actual })
			}
		}
	}

	expect(checked).toBe(0x11_00_00)
	expect(failures.slice(0, 5)).toEqual([])
})
