/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { newLicenseID, newRefreshSecret, secretDigest } from "@mailwoman/license-worker/identifiers"
import { describe, expect, it } from "vitest"

describe("identifiers", () => {
	it("mints a lid of 4 + 22 url-safe characters and never the same one twice", () => {
		const a = newLicenseID()
		const b = newLicenseID()

		expect(a).toMatch(/^lic_[A-Za-z0-9_-]{22}$/u)
		expect(a).not.toBe(b)
	})

	it("mints a 43-character refresh secret and digests it to 64 hex digits", async () => {
		const secret = newRefreshSecret()

		expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/u)
		expect(await secretDigest(secret)).toMatch(/^[0-9a-f]{64}$/u)
		expect(await secretDigest("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
	})
})
