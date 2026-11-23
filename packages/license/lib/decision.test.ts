// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, it } from "vitest"

import { auditLicenseDecision, type ElectedLicense } from "#decision"

const OPERATIONS = ["transform", "train", "distribute-rows"] as const

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
				operations: { "distribute-rows": { permission: "permitted", basis: "other-documented", because: "Facts." } },
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

describe("auditLicenseDecision purposes", () => {
	it("holds a purpose reading and an exception to the rules an operation reading follows", () => {
		const problems = auditLicenseDecision(
			elected({
				purposes: { "commercial-use": { permission: "permitted", because: "No noncommercial clause." } },
				purposeExceptions: {
					"distribute-rows": { sale: { permission: "refused", because: "" } },
					// A register read from JSON can name a purpose or an operation the types don't.
					...({ lease: { resale: { permission: "refused", because: "No resale." } } } as object),
				},
			}),
			OPERATIONS
		)

		expect(problems).toEqual([
			'license "county" permits commercial-use and names no basis for the permission',
			'license "county" reads refused for sale of distribute-rows and gives no reason',
			'license "county" names "lease", which is not an operation this repository performs',
			'license "county" names "resale" for lease, which is not a use purpose',
		])
	})
})
