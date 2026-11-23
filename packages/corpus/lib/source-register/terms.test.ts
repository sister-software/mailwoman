// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { auditLicenseDecision, type LicenseDecision } from "@mailwoman/license/decision"
import { SourceOperation } from "@mailwoman/license/operations"
import { describe, expect, it } from "vitest"

import { registerRowTerms, RegisterTermsBasis, type RegisterTermsInput } from "#source-register/terms"

const permitted = (basis: "publisher-grant" | "other-documented") => ({
	[SourceOperation.DistributeRows]: { permission: "permitted" as const, basis, because: "Read. Second sentence." },
})

const LICENSES: LicenseDecision<SourceOperation>[] = [
	{
		licenseID: "cc-by",
		state: "elected",
		electedTerms: "Creative Commons Attribution 4.0 International",
		spdx: "CC-BY-4.0",
		retrievedCopy: "receipts/cc-by/",
		electedBecause: "The publisher states CC BY 4.0.",
		operations: permitted("publisher-grant"),
	},
	{
		licenseID: "facts-disclaimer",
		state: "elected",
		electedTerms: "US factual data published without a use restriction",
		retrievedCopy: "receipts/facts/",
		electedBecause: "The county's only rights text is a disclaimer.",
		reading: { url: "https://example.org/item?f=json", found: "terms", quote: "provided as is" },
		operations: permitted("other-documented"),
	},
	{
		licenseID: "facts-empty",
		state: "elected",
		electedTerms: "US factual data published without a use restriction",
		retrievedCopy: "receipts/facts/",
		electedBecause: "Every field read is empty.",
		reading: { url: "https://example.org/empty?f=json", found: "no-statement" },
		operations: permitted("other-documented"),
	},
	{
		licenseID: "facts-unrecorded",
		state: "elected",
		electedTerms: "US factual data published without a use restriction",
		retrievedCopy: "receipts/facts/",
		electedBecause: "Read before readings were structured.",
		operations: permitted("other-documented"),
	},
	{
		licenseID: "refused",
		state: "refused",
		refusedBecause: "The county withholds redistribution. It names its board.",
	},
	{ licenseID: "unchecked", state: "unchecked", publisherStatement: "Free", note: "Not read." },
	{
		licenseID: "elected-without-redistribution",
		state: "elected",
		electedTerms: "Portal terms",
		retrievedCopy: "receipts/portal/",
		electedBecause: "Read for training only.",
	},
]

const REGISTER: RegisterTermsInput = {
	sources: [
		...LICENSES.map((decision) => ({
			sourceID: `row-${decision.licenseID}`,
			license: decision.licenseID,
			publisher: `Publisher ${decision.licenseID}`,
			name: decision.licenseID,
		})),
		{ sourceID: "row-dangling", license: "no-such-license", name: "dangling" },
	],
	licenses: LICENSES,
}

const basisOf = (id: string) => registerRowTerms(REGISTER, id).basis

describe("registerRowTerms", () => {
	it("reads each decision for redistribution, the operation a served layer performs", () => {
		expect(basisOf("row-cc-by")).toBe(RegisterTermsBasis.OpenLicense)
		expect(basisOf("row-facts-disclaimer")).toBe(RegisterTermsBasis.NoRestrictingTerms)
		expect(basisOf("row-refused")).toBe(RegisterTermsBasis.Refused)
		expect(basisOf("row-unchecked")).toBe(RegisterTermsBasis.Unread)
		// Elected terms silent on redistribution read as unread for it.
		expect(basisOf("row-elected-without-redistribution")).toBe(RegisterTermsBasis.Unread)
	})

	it("keeps a page that states nothing apart from terms read and found not to restrict", () => {
		expect(registerRowTerms(REGISTER, "row-facts-disclaimer")).toMatchObject({
			statement: "terms",
			termsURL: "https://example.org/item?f=json",
		})

		expect(registerRowTerms(REGISTER, "row-facts-empty").statement).toBe("no-statement")
		// A decision that records no structured reading leaves the finding unknown rather than guessed from its prose.
		expect(registerRowTerms(REGISTER, "row-facts-unrecorded").statement).toBeNull()
	})

	it("reads a missing row and a row without a decision as unregistered", () => {
		expect(basisOf("row-absent")).toBe(RegisterTermsBasis.Unregistered)

		expect(registerRowTerms(REGISTER, "row-dangling")).toMatchObject({
			basis: RegisterTermsBasis.Unregistered,
			licenseID: "no-such-license",
		})
	})
})

describe("auditLicenseDecision on a terms reading", () => {
	it("refuses a refusal resting on a page that states nothing", () => {
		expect(
			auditLicenseDecision(
				{
					licenseID: "x",
					state: "refused",
					refusedBecause: "No grant.",
					reading: { url: "https://example.org/", found: "no-statement" },
				},
				[]
			)
		).toEqual([`license "x" is refused on a reading that found no statement`])
	})
})
