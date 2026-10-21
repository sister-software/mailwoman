/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { stringifyJSON } from "@mailwoman/core/json"
import { decodeLicenseKeyPayload } from "@mailwoman/core/license/key"
import { env } from "cloudflare:workers"
import { beforeAll, describe, expect, it } from "vitest"

import { createLicenseWorkerApp } from "#app"
import type { LicenseEmail } from "#email/provider"
import { readEnv } from "#env"
import { openLedger } from "#ledger/client"
import { stripeClient } from "#stripe/client"
import { envWithSigningKey } from "#test/support/keys"
import { applyMigrations } from "#test/support/migrations"

const OCT_21 = Date.UTC(2026, 9, 21)

beforeAll(async () => {
	await applyMigrations(env.LICENSE_LEDGER)
})

interface IssuedBody {
	status: string
	token: string
	lid: string
	secret?: string
	refresh_secret?: string
	claim?: string
	issued: string
	expires: string
}

async function app(options: { now?: number } = {}) {
	const signing = await envWithSigningKey(readEnv(env))
	const worker = signing.env
	const sent: LicenseEmail[] = []

	const hono = createLicenseWorkerApp(worker, {
		signingStatus: () => "ok",
		email: {
			send: async (message) => {
				sent.push(message)

				return { messageID: `msg_${sent.length}` }
			},
		},
		ledger: openLedger(env.LICENSE_LEDGER),
		stripe: stripeClient(worker),
		fetch: (async () => new Response("GNU AFFERO GENERAL PUBLIC LICENSE", { status: 200 })) as typeof fetch,
		now: () => options.now ?? OCT_21,
	})

	function post(path: string, body: object) {
		return hono.request(path, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: stringifyJSON(body),
		})
	}

	return { worker, hono, sent, post, get: (path: string) => hono.request(path) }
}

describe("the declaration routes", () => {
	it("declare: an open-source declaration answers the token and the secret in the response", async () => {
		const a = await app()

		const response = await a.post("/v1/declarations", {
			intent: "open-source",
			name: "Example Project",
			sourceURL: "https://github.com/example/project",
		})

		expect(response.status).toBe(200)
		expect(response.headers.get("cache-control")).toBe("no-store")

		const body = (await response.json()) as IssuedBody

		expect(body).toMatchObject({ status: "issued", issued: "2026-10-21", expires: "2027-03-11" })
		expect(body.token.startsWith("mwl1.")).toBe(true)
		expect(body.secret).toMatch(/^[A-Za-z0-9_-]{43}$/u)
		expect(a.sent).toHaveLength(0)
	})

	it("declare: an academic declaration answers a claim, and the claim route answers the token with the secret once", async () => {
		const a = await app()

		const pending = (await (
			await a.post("/v1/declarations", {
				intent: "academic",
				name: "Dr Example",
				organization: "Example University",
				email: "prof@example.edu",
			})
		).json()) as IssuedBody

		expect(pending.status).toBe("pending")
		expect(pending.claim).toMatch(/^clm_[A-Za-z0-9_-]{22}$/u)
		expect(a.sent[0]?.to).toBe("prof@example.edu")

		const first = (await (await a.get(`/v1/declarations/${pending.claim}`)).json()) as IssuedBody

		expect(first).toMatchObject({ status: "issued", licensee: "Dr Example", expires: "2027-10-21" })
		expect(first.refresh_secret).toMatch(/^[A-Za-z0-9_-]{43}$/u)

		const again = (await (await a.get(`/v1/declarations/${pending.claim}`)).json()) as IssuedBody

		expect(again.refresh_secret).toBeUndefined()
		expect(again.token).toBe(first.token)
		expect((await a.get(`/v1/declarations/clm_${"x".repeat(22)}`)).status).toBe(404)
	})

	it("declare: a missing required field is 400", async () => {
		const a = await app()

		expect((await a.post("/v1/declarations", { intent: "open-source", name: "X" })).status).toBe(400)
		expect((await a.post("/v1/declarations", { intent: "student", name: "X" })).status).toBe(400)
		expect((await a.post("/v1/declarations", { intent: "commercial", name: "X" })).status).toBe(400)
	})

	it("evaluate: the first request for an address is pending and the second is 409", async () => {
		const a = await app()
		const body = { email: "trial@example.com", name: "Trial Ltd" }

		const first = await a.post("/v1/evaluations", body)

		expect(first.status).toBe(200)
		expect(await first.json()).toMatchObject({ status: "pending" })

		const second = await a.post("/v1/evaluations", body)

		expect(second.status).toBe(409)
		expect(await second.json()).toEqual({ error: "evaluation exists" })
		expect(a.sent).toHaveLength(1)
		expect(a.sent[0]).toMatchObject({ intent: "evaluation", expires: "2026-11-20" })
	})

	it("refresh and status answer a declared lid, and refresh re-issues within 28 days of expiry", async () => {
		const a = await app()

		const issued = (await (
			await a.post("/v1/declarations", {
				intent: "open-source",
				name: "Example Project",
				sourceURL: "https://github.com/example/project",
			})
		).json()) as IssuedBody

		const early = await a.post("/v1/licenses/refresh", { lid: issued.lid, secret: issued.secret })

		expect(early.status).toBe(200)
		expect(await early.json()).toMatchObject({ status: "active", token: issued.token })

		expect(await (await a.post("/v1/license-status", { lid: issued.lid })).json()).toEqual({ status: "active" })

		const wrong = await a.post("/v1/licenses/refresh", { lid: issued.lid, secret: "x".repeat(43) })

		expect(wrong.status).toBe(404)

		const later = await app({ now: Date.UTC(2027, 2, 1) })

		const reissued = (await (
			await later.post("/v1/licenses/refresh", { lid: issued.lid, secret: issued.secret })
		).json()) as IssuedBody

		expect(reissued.status).toBe("active")
		expect(decodeLicenseKeyPayload(reissued.token)).toMatchObject({ seq: 2, expires: "2027-06-10" })
	})
})
