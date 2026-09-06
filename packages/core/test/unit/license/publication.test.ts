/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The well-known register check over the scripted transport. The two non-verdicts are the point: a site that answers
 *   without a register and a site that does not answer call for different actions, and one word for both hid a
 *   deployment that dropped the file behind "no route to mailwoman.ai".
 */

import { stubTransport } from "@mailwoman/core/api/test-transport"
import { confirmLicenseKeyPublished, licenseKeysWellKnownURL } from "@mailwoman/core/license/publication"
import { describe, expect, it } from "vitest"

const register = {
	format: "mailwoman-license-keys/1",
	keys: [
		{ kid: "v9-active00", status: "active", publicKeyPEM: "-----BEGIN PUBLIC KEY-----" },
		{ kid: "v9-retired0", status: "retired", publicKeyPEM: "-----BEGIN PUBLIC KEY-----" },
	],
}

describe("the well-known register check", () => {
	it("asks the well-known path and answers listed, retired, or unlisted from the register", async () => {
		const listed = stubTransport([{ body: register }])

		expect(await confirmLicenseKeyPublished("v9-active00", { axios: listed.axios })).toBe("listed")
		expect(listed.calls).toEqual([licenseKeysWellKnownURL()])

		const retired = stubTransport([{ body: register }])

		expect(await confirmLicenseKeyPublished("v9-retired0", { axios: retired.axios })).toBe("retired")

		const unlisted = stubTransport([{ body: register }])

		expect(await confirmLicenseKeyPublished("v9-missing0", { axios: unlisted.axios })).toBe("unlisted")
	})

	it("reads a site that answers without a register as unpublished, apart from a site that does not answer", async () => {
		const notFound = stubTransport([{ status: 404, body: "<!doctype html><title>Not found</title>" }])

		expect(await confirmLicenseKeyPublished("v9-active00", { axios: notFound.axios })).toBe("unpublished")

		// A soft 404: the page a static host serves with a 200 when the path has nothing behind it.
		const softNotFound = stubTransport([{ body: "<!doctype html><title>Page not found</title>" }])

		expect(await confirmLicenseKeyPublished("v9-active00", { axios: softNotFound.axios })).toBe("unpublished")

		const down = stubTransport([{ throws: { message: "connect ECONNREFUSED", code: "ERR_NETWORK" } }])

		expect(await confirmLicenseKeyPublished("v9-active00", { axios: down.axios })).toBe("unreachable")

		const failing = stubTransport([{ status: 503, body: "<!doctype html><title>Service unavailable</title>" }])

		expect(await confirmLicenseKeyPublished("v9-active00", { axios: failing.axios })).toBe("unreachable")
	})
})
