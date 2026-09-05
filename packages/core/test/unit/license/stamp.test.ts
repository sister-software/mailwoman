/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import {
	buildEngineStamp,
	encodeLicenseKey,
	generateLicenseSigningKeyPair,
	licenseKeyID,
	type LicenseKeyPayload,
	licenseNoticeLines,
	licensePageURL,
	verifyLicenseKey,
} from "@mailwoman/core/license"
import { describe, expect, it } from "vitest"

const EXPRESSION = "AGPL-3.0-only OR LicenseRef-Commercial"
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

const token = encodeLicenseKey(payload, pair.privateKeyPEM)
const valid = verifyLicenseKey(token, { trustedKeys, now: new Date("2027-01-01T00:00:00Z") })
const expired = verifyLicenseKey(token, { trustedKeys, now: new Date("2027-09-04T00:00:00Z") })
const unknownKey = verifyLicenseKey(token, { trustedKeys: {}, now: new Date("2027-01-01T00:00:00Z") })
const invalid = verifyLicenseKey("mwl1.not.real", { trustedKeys })

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
		expect(stamp.notice).toBeUndefined()
	})

	it.each([
		["expired", expired],
		["unknown_key", unknownKey],
		["invalid", invalid],
	])("reads the open-source branch with a notice for a key that reads %s", (_status, key) => {
		const stamp = buildEngineStamp({ version: "9.2.0", expression: EXPRESSION, key })

		expect(stamp.license).toBe("AGPL-3.0-only")
		expect(stamp.notice).toBeDefined()
	})

	it("never carries the licensee or the key id, whatever the key reads", () => {
		for (const key of [undefined, valid, expired, unknownKey, invalid]) {
			const stamp = buildEngineStamp({ version: "9.2.0", expression: EXPRESSION, key })

			expect(Object.keys(stamp).toSorted()).toEqual(
				["license", "license_url", "name", "version", ...(stamp.notice ? ["notice"] : [])].toSorted()
			)

			expect(JSON.stringify(stamp)).not.toContain("Example Ltd")
			expect(JSON.stringify(stamp)).not.toContain(kid)
		}
	})

	it("honours a configured docs URL", () => {
		const stamp = buildEngineStamp({ version: "9.2.0", expression: EXPRESSION, docsURL: "http://localhost:3000/" })

		expect(stamp.license_url).toBe("http://localhost:3000/license")
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

		expect(licenseNoticeLines(stamp, valid)).toBeUndefined()
	})
})
