// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, it } from "vitest"

import { auditLicenseDecision, type ElectedLicense } from "#license/decision"

const OPERATIONS = ["transform", "train", "redistribute-data"] as const

const elected = (overrides: Partial<ElectedLicense<(typeof OPERATIONS)[number]>>) =>
	({
		licenseID: "county",
		state: "elected",
		electedTerms: "US factual data published without a use restriction",
		retrievedCopy: "receipts/county/",
		electedBecause: "The terms restrict no use.",
		...overrides,
	}) as const

describe("auditLicenseDecision obligations", () => {
	it("admits an indemnity beside a permitted redistribution, because the clause restricts no use", () => {
		const problems = auditLicenseDecision(
			elected({
				obligations: [
					{ obligation: "indemnity", strength: "required", quote: "The user agrees to indemnify the County." },
				],
				operations: { "redistribute-data": { permission: "permitted", basis: "other-documented", because: "Facts." } },
			}),
			OPERATIONS
		)

		expect(problems).toEqual([])
	})

	it("refuses an indemnity or any other obligation recorded without the publisher's words", () => {
		for (const obligation of ["indemnity", "use_restriction"] as const) {
			expect(
				auditLicenseDecision(elected({ obligations: [{ obligation, strength: "required", quote: "" }] }), OPERATIONS)
			).toEqual([expect.stringContaining(`records ${obligation} without the publisher's words`)])
		}
	})
})
