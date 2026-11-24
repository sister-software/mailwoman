// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, it } from "vitest"

import { GROUPING_IDS } from "#artifacts/groupings/groupings"
import { getGrouping, groupingMembers, groupingsOf } from "#groupings"
import { getCountryByAlpha2 } from "#iso3166/records"

describe("groupingMembers", () => {
	it("answers on a date: the United Kingdom is an EU member before 2020-01-31 and not after", () => {
		const codes = (at: string) => groupingMembers("eu", { at }).map((member) => member.code)

		expect(codes("2019-06-01")).toContain("GB")
		expect(codes("2020-06-01")).not.toContain("GB")
	})

	it("agrees with groupingsOf for every answering grouping on one date", () => {
		const at = "2026-11-24"

		for (const id of GROUPING_IDS) {
			if (getGrouping(id).blockedBy.length) continue

			for (const member of groupingMembers(id, { at })) {
				expect(groupingsOf(member.code, { at }), `${member.code} in ${id}`).toContain(id)
			}
		}
	})

	it("states an ISO 3166-1 record for every member whose code status is ISO", () => {
		for (const id of GROUPING_IDS) {
			if (getGrouping(id).blockedBy.length) continue

			for (const member of groupingMembers(id, { at: "2026-11-24" })) {
				if (member.codeStatus === "source-extension") continue

				expect(getCountryByAlpha2(member.code), `${member.code} in ${id}`).not.toBeNull()
			}
		}
	})

	it("refuses a date outside YYYY-MM-DD", () => {
		expect(() => groupingMembers("g7", { at: "2026" })).toThrow(RangeError)
	})
})
