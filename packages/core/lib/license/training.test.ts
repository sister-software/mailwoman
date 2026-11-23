// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { deploymentAdmission } from "@mailwoman/license/product/entitlement"
import { describe, expect, it } from "vitest"

import { readLocalJSONFile } from "#fs/readers"
import { verifyLicenseKey, verifyTrainingGrant } from "#license/key"
import { checkTrainingEntitlement } from "#license/training"
import { resolvePackagePath } from "#module/resolvers"

interface TokenFixtures {
	trusted_license_keys: Record<string, string>
	cases: Array<{
		name: string
		token: string | null
		now: string
		expect: { license_key: string; training_grant: string; training: string }
	}>
}

const fixtures = await readLocalJSONFile<TokenFixtures>(
	resolvePackagePath("@mailwoman/license", "test", "fixtures", "product", "tokens.json")
)

const trustedKeys = fixtures.trusted_license_keys

describe("the shared product-token fixtures", () => {
	// The Rust verifier runs the same cases in packages/license/crates/product-license/tests/fixtures.rs.
	it.each(fixtures.cases)("$name", async ({ token, now, expect: expected }) => {
		const at = new Date(now)
		const admission = await checkTrainingEntitlement(token, { trustedKeys, now: at })

		expect({
			license_key: (await verifyLicenseKey(token ?? "", { trustedKeys, now: at })).status,
			training_grant: (await verifyTrainingGrant(token ?? "", { trustedKeys, now: at })).status,
			training: admission.admitted ? "admitted" : admission.refusal,
		}).toEqual(expected)
	})
})

describe("deployment of a trained model", () => {
	const active = fixtures.cases.find((c) => c.expect.training === "admitted")!

	it("admits a grant that permits deploy and carries the model's grant ID, and refuses another grant", async () => {
		const verification = await verifyTrainingGrant(active.token!, { trustedKeys, now: new Date(active.now) })

		expect(deploymentAdmission(verification, "mtg_0123456789abcdef01234567")).toMatchObject({ admitted: true })

		expect(deploymentAdmission(verification, "mtg_ffffffffffffffffffffffff")).toMatchObject({
			admitted: false,
			refusal: "other_grant",
		})
	})

	it("refuses an expired grant even though the model's provenance still names it", async () => {
		const verification = await verifyTrainingGrant(active.token!, {
			trustedKeys,
			now: new Date("2027-02-01T00:00:00.000Z"),
		})

		expect(deploymentAdmission(verification, "mtg_0123456789abcdef01234567")).toMatchObject({
			admitted: false,
			refusal: "expired",
		})
	})
})
