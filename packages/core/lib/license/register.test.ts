// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import {
	LICENSE_SIGNING_KEYS,
	LicenseKeyStatus,
	PROVENANCE_SIGNING_KEYS,
	trustedLicenseSigningKeys,
	trustedProvenanceSigningKeys,
} from "@mailwoman/license/product/trust"
import { describe, expect, it } from "vitest"

import { readLocalJSONFile } from "#fs/readers"
import { licenseKeyID, provenanceKeyID, publishedLicenseKeys } from "#license"
import { repoRootPath } from "#paths"

describe("the product trust register", () => {
	it("holds at least the operator's license key, and every kid is the digest of its own public key", async () => {
		expect(LICENSE_SIGNING_KEYS.length).toBeGreaterThan(0)

		for (const key of LICENSE_SIGNING_KEYS) {
			await expect(licenseKeyID(key.publicKeyPEM, key.majorVersions[0]!)).resolves.toBe(key.kid)
		}

		for (const key of PROVENANCE_SIGNING_KEYS) {
			await expect(provenanceKeyID(key.publicKeyPEM, key.majorVersions[0]!)).resolves.toBe(key.kid)
		}
	})

	it("trusts active and retired keys offline and never a revoked one", () => {
		const trusted = { ...trustedLicenseSigningKeys(), ...trustedProvenanceSigningKeys() }

		for (const key of [...LICENSE_SIGNING_KEYS, ...PROVENANCE_SIGNING_KEYS]) {
			expect(key.kid in trusted).toBe(key.status !== LicenseKeyStatus.Revoked)
		}
	})

	it("keeps a public key out of both sets, so a license key never attests to model bytes", () => {
		const provenance = new Set(PROVENANCE_SIGNING_KEYS.map((key) => key.publicKeyPEM.trim()))

		for (const key of LICENSE_SIGNING_KEYS) {
			expect(provenance.has(key.publicKeyPEM.trim())).toBe(false)
		}
	})

	it("derives the committed well-known JSON exactly", async () => {
		const committed = await readLocalJSONFile<unknown>(
			repoRootPath("docs", "static", ".well-known", "mailwoman", "license-keys.json")
		)

		expect(committed).toEqual(publishedLicenseKeys())
	})
})
