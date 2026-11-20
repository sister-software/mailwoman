// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { ObligationRefusal } from "mailwoman/data/obligations"
import { describe, expect, test } from "vitest"

import { itemsRefusal } from "#refusal"

/**
 * The admin gazetteer's recorded license on the lab data root.
 */
const ADMIN_LICENSE = "LicenseRef-WhosOnFirst-Mixed AND ODbL-1.0 AND CC-BY-4.0"

describe("itemsRefusal", () => {
	test("a refused class the license carries keeps items off and states why", () => {
		expect(itemsRefusal(ADMIN_LICENSE, [ObligationRefusal.ShareAlike])).toContain("ODbL-1.0 carries share-alike")
	})

	test("an identifier with no recorded obligations keeps items off under unresolved", () => {
		expect(itemsRefusal(ADMIN_LICENSE, [ObligationRefusal.Unresolved])).toContain(
			"LicenseRef-WhosOnFirst-Mixed resolves to no recorded obligations"
		)

		expect(itemsRefusal(null, [ObligationRefusal.Unresolved])).toContain("records no license")
	})

	test("no refusal, or a refused class the license doesn't carry, serves items", () => {
		expect(itemsRefusal(ADMIN_LICENSE, [])).toBeNull()
		expect(itemsRefusal("CC-BY-4.0", [ObligationRefusal.ShareAlike, ObligationRefusal.Unresolved])).toBeNull()
		expect(itemsRefusal(null, [ObligationRefusal.ShareAlike])).toBeNull()
	})
})
