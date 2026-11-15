// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The `structure` family's declared codepoint classes and script ranges equal the legacy ranges.
 *
 *   Every codepoint from U+0000 to U+10FFFF, including each lone surrogate,
 *   goes through both implementations at a token start, inside a token
 *   and as a one-codepoint text, and the six fields must match.
 *   The legacy functions are the oracle, so the declared ranges are those ranges
 *   and no Unicode property table.
 */

import { isPresent } from "@mailwoman/core/objects"
import { expect, it } from "vitest"

import { codepointInputs, compareOne, culpritCodepoint, generatedInputs } from "#tools/differential"

it("equals the legacy classes and scripts on every Unicode codepoint", { timeout: 600_000 }, () => {
	const failures: Array<{ first: number; culprit: number | null }> = []

	for (const { first, text } of codepointInputs()) {
		if (compareOne(text)) {
			failures.push({ first, culprit: culpritCodepoint(first) })
		}
	}

	expect(failures).toEqual([])
})

it("equals the legacy output on 100,000 generated inputs", { timeout: 600_000 }, () => {
	const differences = generatedInputs(100_000, 7).map(compareOne).filter(isPresent)

	expect(differences.slice(0, 5)).toEqual([])
})
