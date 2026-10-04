// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, test } from "vitest"

import { distinctBlocks } from "#filings"
import { FILING_ROWS } from "#test/fixtures/example-house"

describe("US denominator control", () => {
	test("two speed groups in one block are one distinct block, and every other total stays unknown", () => {
		expect(distinctBlocks(FILING_ROWS)).toEqual({
			blocks: 1,
			buildings: "unknown",
			units: "unknown",
			subscribers: "unknown",
		})
	})
})
