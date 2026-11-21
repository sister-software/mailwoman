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
	const indemnity = [
		{ obligation: "indemnity", strength: "required", quote: "The user agrees to indemnify the County." },
	] as const

	it("refuses an indemnity whose decision still permits redistributing the rows", () => {
		const problems = auditLicenseDecision(
			elected({
				obligations: indemnity,
				operations: { "redistribute-data": { permission: "permitted", basis: "other-documented", because: "Facts." } },
			}),
			OPERATIONS
		)

		expect(problems).toEqual([expect.stringContaining("records an indemnity and does not refuse redistribute-data")])
	})

	it("admits the indemnity once redistribution is refused, and refuses an obligation without the publisher's words", () => {
		const refused = { "redistribute-data": { permission: "refused", because: "An indemnity." } } as const

		expect(auditLicenseDecision(elected({ obligations: indemnity, operations: refused }), OPERATIONS)).toEqual([])

		expect(
			auditLicenseDecision(
				elected({ obligations: [{ obligation: "use_restriction", strength: "required", quote: "" }] }),
				OPERATIONS
			)
		).toEqual([expect.stringContaining("without the publisher's words")])
	})
})
