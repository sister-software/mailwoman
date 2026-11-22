// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, it } from "vitest"

import { appliedLicenseBranch, chooseLicenseBranch, type LicenseKeyPayload } from "#license"

describe("chooseLicenseBranch", () => {
	const dual = "AGPL-3.0-only OR LicenseRef-Commercial"

	it("applies the open-source branch without a commercial agreement", () => {
		expect(chooseLicenseBranch(dual, { commercialAgreement: false })).toBe("AGPL-3.0-only")
	})

	it("applies the commercial branch when an agreement is present", () => {
		expect(chooseLicenseBranch(dual, { commercialAgreement: true })).toBe("LicenseRef-Commercial")
	})

	it("returns a single-branch expression whole", () => {
		expect(chooseLicenseBranch("ODbL-1.0", { commercialAgreement: true })).toBe("ODbL-1.0")
	})
})

describe("appliedLicenseBranch", () => {
	const dual = "AGPL-3.0-only OR LicenseRef-Commercial"

	const payload: LicenseKeyPayload = {
		v: 1,
		kid: "v9-00000000",
		licensee: "Example",
		issued: "2026-10-21",
		expires: "2027-03-11",
		scope: "all",
		terms: "LicenseRef-Commercial",
	}

	it("applies the commercial branch to a valid commercial key", () => {
		expect(appliedLicenseBranch(dual, { status: "valid", kid: payload.kid, payload })).toBe("LicenseRef-Commercial")
	})

	it("applies the open-source branch to a valid key whose terms are AGPL-3.0-only", () => {
		const declared: LicenseKeyPayload = { ...payload, terms: "AGPL-3.0-only", intent: "open-source", seq: 1 }

		expect(appliedLicenseBranch(dual, { status: "valid", kid: payload.kid, payload: declared })).toBe("AGPL-3.0-only")
	})
})
