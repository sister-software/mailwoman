// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { usUnitIdentifier } from "@mailwoman/codex/us/unit/designator"
import { workspacePath } from "@mailwoman/core/paths"
import { JSONSpliterator } from "spliterator"
import { describe, expect, it } from "vitest"

import { type AddressDuplicateRule, type DuplicateCandidate, isDuplicateAddress } from "#address/duplicate"

/**
 * #2978's held-out pair set: 399 cross-source pairs from 20 regions of the 2026-11-08 US layer, sampled with seed 2
 * and adjudicated by LLM judges under one rubric with the rule's verdict hidden.
 */
const HELDOUT = workspacePath("resolver-wof-sqlite", "lib", "address", "fixtures", "duplicate-heldout-2026-11-08.jsonl")

interface HeldoutPair {
	pairID: string
	adjudication: "same-address" | "different-address" | "unsure"
	higher: DuplicateCandidate
	lower: DuplicateCandidate
}

const US_RULE: AddressDuplicateRule = {
	rank: (source) => (source === "usgov-nad" ? 0 : source.startsWith("openaddresses:") ? 1 : 2),
	unitIdentifier: (unit, context) => usUnitIdentifier(unit, context),
}

function candidate(overrides: Partial<DuplicateCandidate>): DuplicateCandidate {
	return {
		source: "usgov-nad",
		unit: null,
		number: "12",
		streetRaw: "Main Street",
		localities: ["Madison"],
		lat: 43.07,
		lon: -89.4,
		stack: 1,
		...overrides,
	}
}

describe("isDuplicateAddress", () => {
	it("reproduces the held-out grade: 263 true drops, 3 wrong drops and 3 missed repeats of 397 pairs", async () => {
		const pairs = (await Array.fromAsync(JSONSpliterator.fromAsync<HeldoutPair>(HELDOUT))).filter(
			(pair) => pair.adjudication !== "unsure"
		)

		let truePositive = 0
		let falsePositive = 0
		let falseNegative = 0

		for (const pair of pairs) {
			const dropped = isDuplicateAddress(US_RULE, pair.higher, pair.lower)
			const label = pair.adjudication === "same-address"

			if (dropped && label) {
				truePositive++
			} else if (dropped) {
				falsePositive++
			} else if (label) {
				falseNegative++
			}
		}

		expect({ graded: pairs.length, truePositive, falsePositive, falseNegative }).toEqual({
			graded: 397,
			truePositive: 263,
			falsePositive: 3,
			falseNegative: 3,
		})
	})

	it("keeps a unit row against a building row, and a namesake in another town", () => {
		expect(isDuplicateAddress(US_RULE, candidate({}), candidate({ unit: "#2" }))).toBe(false)
		expect(isDuplicateAddress(US_RULE, candidate({ unit: "UNIT 2" }), candidate({ unit: "#2" }))).toBe(true)
		expect(isDuplicateAddress(US_RULE, candidate({}), candidate({ localities: ["Monona"], lat: 43.2 }))).toBe(false)
		expect(isDuplicateAddress(US_RULE, candidate({}), candidate({ localities: ["Monona"], lat: 43.071 }))).toBe(true)
	})

	it("reads a stacked point's distance as unknown, so disagreeing localities alone do not keep the pair apart", () => {
		expect(
			isDuplicateAddress(US_RULE, candidate({}), candidate({ localities: ["Monona"], lat: 37.5, stack: 500 }))
		).toBe(true)
	})
})
