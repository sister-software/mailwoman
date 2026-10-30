/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests the well-known register check over a scripted transport. The check distinguishes a site that answers without a register from a site that does not answer because each requires a different action.
 */

import { describe, expect, it } from "vitest"

import { stubTransport } from "#api/test/transport"
import { confirmLicenseKeyPublished, licenseKeysWellKnownURL } from "#license/publication"

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

		await expect(confirmLicenseKeyPublished("v9-active00", { axios: listed.axios })).resolves.toBe("listed")
		expect(listed.calls).toEqual([licenseKeysWellKnownURL()])

		const retired = stubTransport([{ body: register }])

		await expect(confirmLicenseKeyPublished("v9-retired0", { axios: retired.axios })).resolves.toBe("retired")

		const unlisted = stubTransport([{ body: register }])

		await expect(confirmLicenseKeyPublished("v9-missing0", { axios: unlisted.axios })).resolves.toBe("unlisted")
	})

	it("reads a site that answers without a register as unpublished, apart from a site that does not answer", async () => {
		const notFound = stubTransport([{ status: 404, body: "<!doctype html><title>Not found</title>" }])

		await expect(confirmLicenseKeyPublished("v9-active00", { axios: notFound.axios })).resolves.toBe("unpublished")

		// A soft 404: the page a static host serves with a 200 when the path has no resource behind it.
		const softNotFound = stubTransport([{ body: "<!doctype html><title>Page not found</title>" }])

		await expect(confirmLicenseKeyPublished("v9-active00", { axios: softNotFound.axios })).resolves.toBe("unpublished")

		const down = stubTransport([{ throws: { message: "connect ECONNREFUSED", code: "ERR_NETWORK" } }])

		await expect(confirmLicenseKeyPublished("v9-active00", { axios: down.axios })).resolves.toBe("unreachable")

		const failing = stubTransport([{ status: 503, body: "<!doctype html><title>Service unavailable</title>" }])

		await expect(confirmLicenseKeyPublished("v9-active00", { axios: failing.axios })).resolves.toBe("unreachable")
	})
})
