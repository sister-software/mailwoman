/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import {
	decodeLicenseKeyPayload,
	encodeLicenseKey,
	generateLicenseSigningKeyPair,
	isSelfServicePayload,
	LICENSE_KEY_PREFIX,
	licenseKeyID,
	type LicenseKeyPayload,
	verifyLicenseKey,
} from "@mailwoman/core/license"
import { resolvePackagePath } from "@mailwoman/core/module/resolvers"
import { describe, expect, it } from "vitest"

interface LegacyFixture {
	privateKeyPEM: string
	publicKeyPEM: string
	kid: string
	payload: LicenseKeyPayload
	token: string
}

const legacy = await readLocalJSONFile<LegacyFixture>(
	resolvePackagePath("@mailwoman/core", "test", "fixtures", "license", "legacy-token.json")
)

const pair = await generateLicenseSigningKeyPair()
const kid = await licenseKeyID(pair.publicKeyPEM, 9)
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
	it("verifies the token the node:crypto implementation signed, and re-signs it byte for byte", async () => {
		const trusted = { [legacy.kid]: legacy.publicKeyPEM }

		expect(
			await verifyLicenseKey(legacy.token, { trustedKeys: trusted, now: new Date("2027-01-01T00:00:00Z") })
		).toEqual({ status: "valid", kid: legacy.kid, payload: legacy.payload })

		expect(await licenseKeyID(legacy.publicKeyPEM, 9)).toBe(legacy.kid)
		expect(await encodeLicenseKey(legacy.payload, legacy.privateKeyPEM)).toBe(legacy.token)
	})

	it("round-trips a signed payload and reads valid before its expiry", async () => {
		const token = await encodeLicenseKey(payload, pair.privateKeyPEM)

		expect(token.startsWith(`${LICENSE_KEY_PREFIX}.`)).toBe(true)

		expect(await verifyLicenseKey(token, { trustedKeys, now: new Date("2027-01-01T00:00:00Z") })).toEqual({
			status: "valid",
			kid,
			payload,
		})
	})

	it("is valid through the last day and expired the day after", async () => {
		const token = await encodeLicenseKey(payload, pair.privateKeyPEM)

		expect((await verifyLicenseKey(token, { trustedKeys, now: new Date("2027-09-03T23:00:00Z") })).status).toBe("valid")

		expect((await verifyLicenseKey(token, { trustedKeys, now: new Date("2027-09-04T00:00:00Z") })).status).toBe(
			"expired"
		)
	})

	it("refuses a tampered payload — the signature covers the prefix and the payload", async () => {
		const token = await encodeLicenseKey(payload, pair.privateKeyPEM)
		const [prefix, , signature] = token.split(".") as [string, string, string]
		const forged = Buffer.from(JSON.stringify({ ...payload, licensee: "Someone Else" })).toString("base64url")

		expect(await verifyLicenseKey(`${prefix}.${forged}.${signature}`, { trustedKeys })).toMatchObject({
			status: "invalid",
			reason: expect.stringContaining("signature does not verify"),
		})
	})

	it("names an unknown key id rather than failing generically", async () => {
		const other = await generateLicenseSigningKeyPair()
		const otherKid = await licenseKeyID(other.publicKeyPEM, 9)
		const token = await encodeLicenseKey({ ...payload, kid: otherKid }, other.privateKeyPEM)

		expect(await verifyLicenseKey(token, { trustedKeys })).toMatchObject({ status: "unknown_key", kid: otherKid })
	})

	it("refuses a token under another prefix or with an unreadable payload", async () => {
		expect((await verifyLicenseKey("mwl2.abc.def", { trustedKeys })).status).toBe("invalid")

		expect(
			await verifyLicenseKey(`${LICENSE_KEY_PREFIX}.${Buffer.from("{}").toString("base64url")}.x`, { trustedKeys })
		).toMatchObject({ status: "invalid", reason: expect.stringContaining("payload unreadable") })
	})

	it("derives a key id from the major version and the public key's digest", async () => {
		expect(kid).toMatch(/^v9-[0-9a-f]{8}$/u)
		expect(await licenseKeyID(pair.publicKeyPEM, 10)).toMatch(/^v10-[0-9a-f]{8}$/u)
		expect(await licenseKeyID((await generateLicenseSigningKeyPair()).publicKeyPEM, 9)).not.toBe(kid)
	})

	it("carries lid and agreement when a self-service issuer sets them; a hand-issued payload reads as not self-service", async () => {
		const selfService: LicenseKeyPayload = {
			...payload,
			lid: "lic_0123456789abcdefghijkl",
			agreement: "commercial-2026-10",
		}

		const token = await encodeLicenseKey(selfService, pair.privateKeyPEM)
		const verified = await verifyLicenseKey(token, { trustedKeys, now: new Date("2027-01-01T00:00:00Z") })

		expect(verified).toMatchObject({ status: "valid", payload: selfService })
		expect(isSelfServicePayload(selfService)).toBe(true)
		expect(isSelfServicePayload(payload)).toBe(false)
	})

	it("refuses an empty lid or agreement", async () => {
		await expect(encodeLicenseKey({ ...payload, lid: "" }, pair.privateKeyPEM)).rejects.toThrow(/Too small/u)
		await expect(encodeLicenseKey({ ...payload, agreement: "" }, pair.privateKeyPEM)).rejects.toThrow(/Too small/u)
	})

	it("decodes a token's payload as written, without trusting it, and answers nothing for a malformed token", () => {
		expect(decodeLicenseKeyPayload(legacy.token)).toMatchObject({ kid: legacy.kid, licensee: expect.any(String) })
		expect(decodeLicenseKeyPayload("mwl1.not-base64url.sig")).toBeUndefined()
		expect(decodeLicenseKeyPayload("mwl2.a.b")).toBeUndefined()
		expect(decodeLicenseKeyPayload("two.parts")).toBeUndefined()
	})
})
