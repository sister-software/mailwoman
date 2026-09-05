/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import {
	LICENSE_SIGNING_KEYS,
	licenseKeyID,
	LicenseKeyStatus,
	publishedLicenseKeys,
	trustedLicenseSigningKeys,
} from "@mailwoman/core/license"
import { repoRootPath } from "@mailwoman/core/paths"
import { describe, expect, it } from "vitest"

describe("the license key register", () => {
	it("holds at least the operator's key, and every kid is the digest of its own public key", async () => {
		expect(LICENSE_SIGNING_KEYS.length).toBeGreaterThan(0)

		for (const key of LICENSE_SIGNING_KEYS) {
			expect(await licenseKeyID(key.publicKeyPEM, key.majorVersions[0]!)).toBe(key.kid)
		}
	})

	it("trusts active and retired keys offline and never a revoked one", () => {
		const trusted = trustedLicenseSigningKeys()

		for (const key of LICENSE_SIGNING_KEYS) {
			expect(key.kid in trusted).toBe(key.status !== LicenseKeyStatus.Revoked)
		}
	})

	it("derives the committed well-known JSON exactly", async () => {
		const committed = await readLocalJSONFile<unknown>(
			repoRootPath("docs", "static", ".well-known", "mailwoman", "license-keys.json")
		)

		expect(committed).toEqual(publishedLicenseKeys())
	})
})
