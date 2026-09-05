/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The worker client over the scripted transport, so the wire is deterministic: the routes answer as
 *   `packages/license-worker/lib/routes/{refresh,status}.ts` do.
 */

import { stubTransport } from "@mailwoman/core/api/test-transport"
import { checkLicenseStatus, licenseWorkerURL, refreshLicenseKey } from "@mailwoman/core/license/status"
import { describe, expect, it } from "vitest"

const LID = `lic_${"a".repeat(22)}`
const SECRET = "s".repeat(43)

describe("the license worker client", () => {
	it("derives the worker origin with no trailing slash", () => {
		expect(licenseWorkerURL("https://license.example/")).toBe("https://license.example")
		expect(licenseWorkerURL(`https://license.example${"/".repeat(50_000)}`)).toBe("https://license.example")
		expect(licenseWorkerURL(undefined)).toBe("https://license.mailwoman.ai")
	})

	it("status answers the worker's word, unknown for a word outside the four, and unreachable when nothing answers", async () => {
		const active = stubTransport([{ body: { status: "active" } }])

		expect(await checkLicenseStatus(LID, { axios: active.axios })).toBe("active")
		expect(active.calls).toEqual(["/v1/license-status"])
		expect(active.configs[0]).toMatchObject({ cache: false })

		const stray = stubTransport([{ body: { status: "on fire" } }])

		expect(await checkLicenseStatus(LID, { axios: stray.axios })).toBe("unknown")

		const down = stubTransport([{ throws: { message: "connect ECONNREFUSED", code: "ERR_NETWORK" } }])

		expect(await checkLicenseStatus(LID, { axios: down.axios })).toBe("unreachable")

		const broken = stubTransport([{ status: 503, body: { error: "signing unavailable" } }])

		expect(await checkLicenseStatus(LID, { axios: broken.axios })).toBe("unreachable")
	})

	it("refresh answers the token, the state that withholds one, not_found for the worker's 404, and unreachable with the reason", async () => {
		const issued = { status: "active", token: "mwl1.a.b", issued: "2026-10-01", expires: "2026-11-15" }
		const ok = stubTransport([{ body: issued }])

		expect(await refreshLicenseKey({ lid: LID, secret: SECRET }, { axios: ok.axios })).toEqual(issued)
		expect(ok.calls).toEqual(["/v1/licenses/refresh"])

		const lapsed = stubTransport([{ body: { status: "lapsed" } }])

		expect(await refreshLicenseKey({ lid: LID, secret: SECRET }, { axios: lapsed.axios })).toEqual({
			status: "lapsed",
		})

		const wrong = stubTransport([{ status: 404, body: { error: "not found" } }])

		expect(await refreshLicenseKey({ lid: LID, secret: "x".repeat(43) }, { axios: wrong.axios })).toEqual({
			status: "not_found",
		})

		const down = stubTransport([{ throws: { message: "connect ECONNREFUSED", code: "ERR_NETWORK" } }])

		expect(await refreshLicenseKey({ lid: LID, secret: SECRET }, { axios: down.axios })).toMatchObject({
			status: "unreachable",
			reason: expect.stringContaining("ECONNREFUSED"),
		})
	})
})
