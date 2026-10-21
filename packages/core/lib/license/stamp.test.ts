/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { stringifyJSON } from "#json"
import {
	buildEngineStamp,
	encodeLicenseKey,
	generateLicenseSigningKeyPair,
	licenseKeyID,
	type LicenseKeyPayload,
	licenseNoticeLines,
	licensePageURL,
	verifyLicenseKey,
} from "#license"

const EXPRESSION = "AGPL-3.0-only OR LicenseRef-Commercial"
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

const token = await encodeLicenseKey(payload, pair.privateKeyPEM)
const valid = await verifyLicenseKey(token, { trustedKeys, now: new Date("2027-01-01T00:00:00Z") })
const expired = await verifyLicenseKey(token, { trustedKeys, now: new Date("2027-09-04T00:00:00Z") })
const unknownKey = await verifyLicenseKey(token, { trustedKeys: {}, now: new Date("2027-01-01T00:00:00Z") })
const invalid = await verifyLicenseKey("mwl1.not.real", { trustedKeys })

const declaredPayload: LicenseKeyPayload = {
	...payload,
	licensee: "Example Project",
	expires: "2027-03-11",
	terms: "AGPL-3.0-only",
	intent: "open-source",
	seq: 1,
	lid: "lic_0123456789abcdefghijkl",
}

const declaredToken = await encodeLicenseKey(declaredPayload, pair.privateKeyPEM)
const validDeclared = await verifyLicenseKey(declaredToken, { trustedKeys, now: new Date("2027-01-01T00:00:00Z") })

describe("licensePageURL", () => {
	it("defaults to mailwoman.ai and strips a trailing slash", () => {
		expect(licensePageURL()).toBe("https://mailwoman.ai/license")
		expect(licensePageURL("http://localhost:3000/")).toBe("http://localhost:3000/license")
	})
})

describe("buildEngineStamp", () => {
	it("reads the open-source branch with a notice when no key is configured", () => {
		const stamp = buildEngineStamp({ version: "9.2.0", expression: EXPRESSION })

		expect(stamp).toEqual({
			name: "mailwoman",
			version: "9.2.0",
			license: "AGPL-3.0-only",
			license_url: "https://mailwoman.ai/license",
			notice:
				"mailwoman is licensed AGPL-3.0-only: modified or network-served copies must offer their source. A commercial license waives that obligation.",
		})
	})

	it("reads the commercial branch with no notice for a valid key", () => {
		const stamp = buildEngineStamp({ version: "9.2.0", expression: EXPRESSION, key: valid })

		expect(stamp.license).toBe("LicenseRef-Commercial")
		expect(stamp.notice).toBeNull()
	})

	it.each([
		["expired", expired],
		["unknown_key", unknownKey],
		["invalid", invalid],
	])("reads the open-source branch with a notice for a key that reads %s", (_status, key) => {
		const stamp = buildEngineStamp({ version: "9.2.0", expression: EXPRESSION, key })

		expect(stamp.license).toBe("AGPL-3.0-only")
		expect(stamp.notice).not.toBeNull()
	})

	it("keeps the open-source branch and states the declaration for a valid AGPL-3.0-only key", () => {
		const stamp = buildEngineStamp({ version: "9.2.0", expression: EXPRESSION, key: validDeclared })

		expect(stamp.license).toBe("AGPL-3.0-only")

		expect(stamp.notice).toBe(
			"mailwoman is licensed AGPL-3.0-only: modified or network-served copies must offer their source. Declared open-source until 2027-03-11."
		)
	})

	it("never carries the licensee or the key id, whatever the key reads", () => {
		for (const key of [undefined, valid, expired, unknownKey, invalid, validDeclared]) {
			const stamp = buildEngineStamp({ version: "9.2.0", expression: EXPRESSION, key })

			expect(Object.keys(stamp).toSorted()).toEqual(["license", "license_url", "name", "notice", "version"])

			expect(stringifyJSON(stamp)).not.toContain("Example Ltd")
			expect(stringifyJSON(stamp)).not.toContain("Example Project")
			expect(stringifyJSON(stamp)).not.toContain(kid)
		}
	})
})

describe("licenseNoticeLines for a declared key", () => {
	const stamp = buildEngineStamp({ version: "9.2.0", expression: EXPRESSION, key: validDeclared })

	it("keeps the obligation line and states the declaration with its holder and the URL", () => {
		expect(licenseNoticeLines(stamp, validDeclared, new Date("2027-01-01T00:00:00Z"))).toEqual([
			"mailwoman is licensed AGPL-3.0-only: modified or network-served copies must offer their source.",
			"Declared open-source for Example Project until 2027-03-11: https://mailwoman.ai/license",
		])
	})

	it("states the lapse and the re-issue command once a declared key has expired", async () => {
		const expiredDeclared = await verifyLicenseKey(declaredToken, {
			trustedKeys,
			now: new Date("2027-03-12T00:00:00Z"),
		})

		const lapsed = buildEngineStamp({ version: "9.2.0", expression: EXPRESSION, key: expiredDeclared })

		expect(licenseNoticeLines(lapsed, expiredDeclared, new Date("2027-03-12T00:00:00Z"))).toEqual([
			"mailwoman is licensed AGPL-3.0-only (the configured license key expired on 2027-03-11): modified or network-served copies must offer their source.",
			"Your declaration expired on 2027-03-11: run `mailwoman license refresh`, or declare again. https://mailwoman.ai/license",
		])
	})

	it("announces the expiry date from 28 days before it", () => {
		const lines = licenseNoticeLines(stamp, validDeclared, new Date("2027-02-20T00:00:00Z"))

		expect(lines?.[1]).toBe(
			"Declared open-source for Example Project until 2027-03-11, which is in 19 days: run `mailwoman license refresh` before then. https://mailwoman.ai/license"
		)
	})
})

describe("licenseNoticeLines", () => {
	it("is two lines for the open-source branch, the second carrying the URL", () => {
		const stamp = buildEngineStamp({ version: "9.2.0", expression: EXPRESSION })

		expect(licenseNoticeLines(stamp)).toEqual([
			"mailwoman is licensed AGPL-3.0-only: modified or network-served copies must offer their source.",
			"A commercial license waives that obligation: https://mailwoman.ai/license",
		])
	})

	it("names the expiry date when the configured key has expired", () => {
		const stamp = buildEngineStamp({ version: "9.2.0", expression: EXPRESSION, key: expired })

		expect(licenseNoticeLines(stamp, expired)?.[0]).toBe(
			"mailwoman is licensed AGPL-3.0-only (the configured license key expired on 2027-09-03): modified or network-served copies must offer their source."
		)
	})

	it("is absent for a valid key", () => {
		const stamp = buildEngineStamp({ version: "9.2.0", expression: EXPRESSION, key: valid })

		expect(licenseNoticeLines(stamp, valid)).toBeNull()
	})
})
