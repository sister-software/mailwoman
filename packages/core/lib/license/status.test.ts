/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The worker client over the scripted transport, so the wire is deterministic: the routes answer as
 *   `packages/license-worker/lib/routes/{refresh,status}.ts` do.
 */

import { describe, expect, it } from "vitest"

import { stubTransport } from "#api/test/transport"
import {
	checkLicenseStatus,
	claimDeclaration,
	declareLicense,
	licenseWorkerURL,
	refreshLicenseKey,
	requestDownload,
	requestEvaluation,
} from "#license/status"

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

describe("the declaration, evaluation, claim and download clients", () => {
	const CLAIM = `clm_${"c".repeat(22)}`

	it("declare posts the declaration and answers issued or pending as the worker does, and refused for a 400", async () => {
		const issued = {
			status: "issued",
			token: "mwl1.a.b",
			lid: LID,
			secret: SECRET,
			issued: "2026-10-21",
			expires: "2027-03-11",
		}

		const ok = stubTransport([{ body: issued }])

		expect(
			await declareLicense(
				{ intent: "open-source", name: "Example Project", sourceURL: "https://github.com/example/project" },
				{ axios: ok.axios }
			)
		).toEqual(issued)

		expect(ok.calls).toEqual(["/v1/declarations"])
		expect(ok.configs[0]).toMatchObject({ cache: false, method: "post" })

		const pending = stubTransport([{ body: { status: "pending", claim: CLAIM } }])

		expect(
			await declareLicense(
				{ intent: "academic", name: "Dr Example", email: "prof@example.edu" },
				{ axios: pending.axios }
			)
		).toEqual({ status: "pending", claim: CLAIM })

		const refused = stubTransport([{ status: 400, body: { error: "missing source url" } }])

		expect(await declareLicense({ intent: "open-source", name: "X" }, { axios: refused.axios })).toEqual({
			status: "refused",
			reason: "missing source url",
		})

		const down = stubTransport([{ throws: { message: "connect ECONNREFUSED", code: "ERR_NETWORK" } }])

		expect(await declareLicense({ intent: "open-source", name: "X" }, { axios: down.axios })).toMatchObject({
			status: "unreachable",
		})
	})

	it("evaluate posts the address and maps the worker's 409 to the evaluation_exists refusal", async () => {
		const pending = stubTransport([{ body: { status: "pending", claim: CLAIM } }])

		expect(
			await requestEvaluation({ email: "trial@example.com", name: "Trial Ltd" }, { axios: pending.axios })
		).toEqual({ status: "pending", claim: CLAIM })

		expect(pending.calls).toEqual(["/v1/evaluations"])

		const exists = stubTransport([{ status: 409, body: { error: "evaluation exists" } }])

		expect(await requestEvaluation({ email: "trial@example.com", name: "Trial Ltd" }, { axios: exists.axios })).toEqual(
			{ status: "refused", reason: "evaluation_exists" }
		)
	})

	it("claim gets the declaration's delivery state and maps the worker's 404 to not_found", async () => {
		const sent = { status: "sent", licensee: "Dr Example", issued: "2026-10-21", expires: "2027-10-21" }
		const ok = stubTransport([{ body: sent }])

		expect(await claimDeclaration(CLAIM, { axios: ok.axios })).toEqual(sent)
		expect(ok.calls).toEqual([`/v1/declarations/${CLAIM}`])
		expect(ok.configs[0]).toMatchObject({ cache: false, method: "get" })

		const missing = stubTransport([{ status: 404, body: { error: "not found" } }])

		expect(await claimDeclaration(CLAIM, { axios: missing.axios })).toEqual({ status: "not_found" })
	})

	it("download posts the token and artifact, and maps 403 to refused, 503 to unavailable and 400 to refused", async () => {
		const granted = {
			status: "granted",
			url: "https://x.r2.cloudflarestorage.com/b/k?X-Amz-Signature=0",
			expires: "2026-10-21T01:00:00.000Z",
			bytes: 1,
		}

		const ok = stubTransport([{ body: granted }])

		expect(await requestDownload({ token: "mwl1.a.b", artifact: "tier:gb-streets" }, { axios: ok.axios })).toEqual(
			granted
		)

		expect(ok.calls).toEqual(["/v1/downloads"])

		const scope = stubTransport([{ status: 403, body: { error: "scope" } }])

		expect(await requestDownload({ token: "mwl1.a.b", artifact: "tier:gb-streets" }, { axios: scope.axios })).toEqual({
			status: "refused",
			reason: "scope",
		})

		const unprovisioned = stubTransport([{ status: 503, body: { error: "downloads unavailable" } }])

		expect(
			await requestDownload({ token: "mwl1.a.b", artifact: "tier:gb-streets" }, { axios: unprovisioned.axios })
		).toEqual({ status: "unavailable" })

		const unknown = stubTransport([{ status: 400, body: { error: "unknown artifact" } }])

		expect(await requestDownload({ token: "mwl1.a.b", artifact: "tier:nowhere" }, { axios: unknown.axios })).toEqual({
			status: "refused",
			reason: "unknown artifact",
		})
	})
})
