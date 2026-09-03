/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import {
	encodeLicenseKey,
	generateLicenseSigningKeyPair,
	LICENSE_KEY_PREFIX,
	licenseKeyID,
	type LicenseKeyPayload,
	verifyLicenseKey,
} from "@mailwoman/core/license"
import { describe, expect, it } from "vitest"

const pair = generateLicenseSigningKeyPair()
const kid = licenseKeyID(pair.publicKeyPEM, 9)
const trustedKeys = { [kid]: pair.publicKeyPEM }

const payload: LicenseKeyPayload = {
	v: 1,
	kid,
	licensee: "Example Ltd",
	issued: "2026-09-03",
	expires: "2027-09-03",
	scope: "all",
	terms: "LicenseRef-Commercial",
}

describe("license key", () => {
	it("round-trips a signed payload and reads valid before its expiry", () => {
		const token = encodeLicenseKey(payload, pair.privateKeyPEM)

		expect(token.startsWith(`${LICENSE_KEY_PREFIX}.`)).toBe(true)

		expect(verifyLicenseKey(token, { trustedKeys, now: new Date("2027-01-01T00:00:00Z") })).toEqual({
			status: "valid",
			kid,
			payload,
		})
	})

	it("is valid through the last day and expired the day after", () => {
		const token = encodeLicenseKey(payload, pair.privateKeyPEM)

		expect(verifyLicenseKey(token, { trustedKeys, now: new Date("2027-09-03T23:00:00Z") }).status).toBe("valid")
		expect(verifyLicenseKey(token, { trustedKeys, now: new Date("2027-09-04T00:00:00Z") }).status).toBe("expired")
	})

	it("refuses a tampered payload — the signature covers the prefix and the payload", () => {
		const token = encodeLicenseKey(payload, pair.privateKeyPEM)
		const [prefix, , signature] = token.split(".") as [string, string, string]
		const forged = Buffer.from(JSON.stringify({ ...payload, licensee: "Someone Else" })).toString("base64url")

		expect(verifyLicenseKey(`${prefix}.${forged}.${signature}`, { trustedKeys })).toMatchObject({
			status: "invalid",
			reason: expect.stringContaining("signature does not verify"),
		})
	})

	it("names an unknown key id rather than failing generically", () => {
		const other = generateLicenseSigningKeyPair()
		const otherKid = licenseKeyID(other.publicKeyPEM, 9)
		const token = encodeLicenseKey({ ...payload, kid: otherKid }, other.privateKeyPEM)

		expect(verifyLicenseKey(token, { trustedKeys })).toMatchObject({ status: "unknown_key", kid: otherKid })
	})

	it("refuses a token under another prefix or with an unreadable payload", () => {
		expect(verifyLicenseKey("mwl2.abc.def", { trustedKeys }).status).toBe("invalid")

		expect(
			verifyLicenseKey(`${LICENSE_KEY_PREFIX}.${Buffer.from("{}").toString("base64url")}.x`, { trustedKeys })
		).toMatchObject({ status: "invalid", reason: expect.stringContaining("payload unreadable") })
	})

	it("derives a key id from the major version and the public key's digest", () => {
		expect(kid).toMatch(/^v9-[0-9a-f]{8}$/u)
		expect(licenseKeyID(pair.publicKeyPEM, 10)).toMatch(/^v10-[0-9a-f]{8}$/u)
		expect(licenseKeyID(generateLicenseSigningKeyPair().publicKeyPEM, 9)).not.toBe(kid)
	})
})
