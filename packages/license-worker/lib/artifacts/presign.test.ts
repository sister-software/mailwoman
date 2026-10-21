/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { presignConfigured, presignObject } from "#artifacts/presign"

const configured = {
	R2_ACCESS_KEY_ID: "testaccesskeyid00000000000000000",
	R2_SECRET_ACCESS_KEY: "testsecretaccesskey000000000000000000000000000000000000000000000",
	R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
	PAID_ARTIFACTS_BUCKET: "mailwoman-paid-test",
}

describe("presignObject", () => {
	it("signs a GET on the bucket's S3 host with a one-hour expiry in the query", async () => {
		const url = new URL(await presignObject(configured, "tiers/gb-streets/2026-10-01/gb-streets.db"))

		expect(url.host).toBe("0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com")
		expect(url.pathname).toBe("/mailwoman-paid-test/tiers/gb-streets/2026-10-01/gb-streets.db")
		expect(url.searchParams.get("X-Amz-Expires")).toBe("3600")
		expect(url.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256")

		expect(url.searchParams.get("X-Amz-Credential")).toMatch(
			/^testaccesskeyid00000000000000000\/\d{8}\/auto\/s3\/aws4_request$/u
		)

		expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/u)
	})

	it("reads as configured only when all four values are set", () => {
		expect(presignConfigured(configured)).toBe(true)
		expect(presignConfigured({ ...configured, PAID_ARTIFACTS_BUCKET: undefined })).toBe(false)
		expect(presignConfigured({})).toBe(false)
	})
})
