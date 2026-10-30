/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { readLocalJSONFile } from "#fs/readers"
import { stringifyJSON } from "#json"
import {
	decodeLicenseKeyPayload,
	encodeLicenseKey,
	generateLicenseSigningKeyPair,
	grantsCommercialTerms,
	isSelfServicePayload,
	LICENSE_KEY_PREFIX,
	LicenseIntent,
	licenseKeyID,
	type LicenseKeyPayload,
	LicenseTerms,
	scopeAdmits,
	verifyLicenseKey,
} from "#license"
import { resolvePackagePath } from "#module/resolvers"

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

		await expect(
			verifyLicenseKey(legacy.token, { trustedKeys: trusted, now: new Date("2027-01-01T00:00:00Z") })
		).resolves.toEqual({ status: "valid", kid: legacy.kid, payload: legacy.payload })

		await expect(licenseKeyID(legacy.publicKeyPEM, 9)).resolves.toBe(legacy.kid)
		await expect(encodeLicenseKey(legacy.payload, legacy.privateKeyPEM)).resolves.toBe(legacy.token)
	})

	it("round-trips a signed payload and reads valid before its expiry", async () => {
		const token = await encodeLicenseKey(payload, pair.privateKeyPEM)

		expect(token.startsWith(`${LICENSE_KEY_PREFIX}.`)).toBe(true)

		await expect(verifyLicenseKey(token, { trustedKeys, now: new Date("2027-01-01T00:00:00Z") })).resolves.toEqual({
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
		const forged = Buffer.from(stringifyJSON({ ...payload, licensee: "Someone Else" })).toString("base64url")

		await expect(verifyLicenseKey(`${prefix}.${forged}.${signature}`, { trustedKeys })).resolves.toMatchObject({
			status: "invalid",
			reason: expect.stringContaining("signature does not verify"),
		})
	})

	it("names an unknown key id rather than failing generically", async () => {
		const other = await generateLicenseSigningKeyPair()
		const otherKid = await licenseKeyID(other.publicKeyPEM, 9)
		const token = await encodeLicenseKey({ ...payload, kid: otherKid }, other.privateKeyPEM)

		await expect(verifyLicenseKey(token, { trustedKeys })).resolves.toMatchObject({
			status: "unknown_key",
			kid: otherKid,
		})
	})

	it("refuses a token under another prefix or with an unreadable payload", async () => {
		expect((await verifyLicenseKey("mwl2.abc.def", { trustedKeys })).status).toBe("invalid")

		await expect(
			verifyLicenseKey(`${LICENSE_KEY_PREFIX}.${Buffer.from("{}").toString("base64url")}.x`, { trustedKeys })
		).resolves.toMatchObject({ status: "invalid", reason: expect.stringContaining("payload unreadable") })
	})

	it("derives a key id from the major version and the public key's digest", async () => {
		expect(kid).toMatch(/^v9-[0-9a-f]{8}$/u)
		await expect(licenseKeyID(pair.publicKeyPEM, 10)).resolves.toMatch(/^v10-[0-9a-f]{8}$/u)
		await expect(licenseKeyID((await generateLicenseSigningKeyPair()).publicKeyPEM, 9)).resolves.not.toBe(kid)
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
		expect(decodeLicenseKeyPayload("mwl1.not-base64url.sig")).toBeNull()
		expect(decodeLicenseKeyPayload("mwl2.a.b")).toBeNull()
		expect(decodeLicenseKeyPayload("two.parts")).toBeNull()
	})
})

describe("declared-intent claims", () => {
	const INSTALL = "6f1e2a4c-9b3d-4e8f-a1c2-0d5e6f7a8b9c"

	it("verifies a commercial token minted before the claims existed", async () => {
		expect(legacy.payload).not.toHaveProperty("intent")
		expect(legacy.payload).not.toHaveProperty("seq")

		const verified = await verifyLicenseKey(legacy.token, {
			trustedKeys: { [legacy.kid]: legacy.publicKeyPEM },
			now: new Date("2027-01-01T00:00:00Z"),
		})

		expect(verified.status).toBe("valid")
		expect(grantsCommercialTerms(verified)).toBe(true)
	})

	it("carries AGPL-3.0-only terms with intent, seq and install", async () => {
		const declared: LicenseKeyPayload = {
			...payload,
			terms: LicenseTerms.OpenSource,
			intent: LicenseIntent.OpenSource,
			seq: 3,
			install: INSTALL,
			lid: "lic_0123456789abcdefghijkl",
		}

		const token = await encodeLicenseKey(declared, pair.privateKeyPEM)

		expect(decodeLicenseKeyPayload(token)).toMatchObject({
			terms: "AGPL-3.0-only",
			intent: "open-source",
			seq: 3,
			install: INSTALL,
		})

		const verified = await verifyLicenseKey(token, { trustedKeys, now: new Date("2027-01-01T00:00:00Z") })

		expect(verified.status).toBe("valid")
		expect(grantsCommercialTerms(verified)).toBe(false)
	})

	it("refuses terms outside the two branches, a seq below 1, and an install that is not a UUID", async () => {
		await expect(
			encodeLicenseKey({ ...payload, terms: "MIT" as LicenseKeyPayload["terms"] }, pair.privateKeyPEM)
		).rejects.toThrow(/Invalid option/u)

		await expect(encodeLicenseKey({ ...payload, seq: 0 }, pair.privateKeyPEM)).rejects.toThrow(/Too small/u)

		await expect(encodeLicenseKey({ ...payload, install: "not-a-uuid" }, pair.privateKeyPEM)).rejects.toThrow(
			/Invalid UUID/u
		)
	})

	it("admits an artifact under scope all, under its own name, and under no other", () => {
		expect(scopeAdmits("all", "tier:gb-streets")).toBe(true)
		expect(scopeAdmits(["tier:gb-streets"], "tier:gb-streets")).toBe(true)
		expect(scopeAdmits(["@mailwoman/neural-weights-en-gb"], "tier:gb-streets")).toBe(false)
	})

	it("reads a payload with a lid and no agreement as self-service", () => {
		expect(isSelfServicePayload({ ...payload, lid: "lic_0123456789abcdefghijkl" })).toBe(true)
	})

	it("grants commercial terms only to a valid token on the commercial branch", () => {
		expect(grantsCommercialTerms(null)).toBe(false)
		expect(grantsCommercialTerms({ status: "expired", kid, payload })).toBe(false)
		expect(grantsCommercialTerms({ status: "valid", kid, payload })).toBe(true)

		expect(
			grantsCommercialTerms({ status: "valid", kid, payload: { ...payload, terms: LicenseTerms.OpenSource } })
		).toBe(false)
	})
})
