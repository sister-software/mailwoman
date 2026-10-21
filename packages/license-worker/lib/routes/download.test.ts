/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { stringifyJSON } from "@mailwoman/core/json"
import { encodeLicenseKey, type LicenseKeyPayload } from "@mailwoman/core/license/key"
import { env } from "cloudflare:workers"
import { beforeAll, describe, expect, it } from "vitest"

import { createLicenseWorkerApp } from "#app"
import type { ArtifactCatalog } from "#artifacts/catalog"
import { type LicenseWorkerBindings, readEnv } from "#env"
import { openLedger } from "#ledger/client"
import { stripeClient } from "#stripe/client"
import { envWithSigningKey } from "#test/support/keys"
import { applyMigrations } from "#test/support/migrations"

const OCT_21 = Date.UTC(2026, 9, 21)

const CATALOG: ArtifactCatalog = {
	"tier:gb-streets": { key: "tiers/gb-streets/2026-10-01/gb-streets.db", bytes: 1 },
	"tier:us-streets/tiers/us-ca.db": { key: "tiers/us-streets/2026-10-01/us-ca.db", bytes: 2 },
}

const R2 = {
	R2_ACCESS_KEY_ID: "testaccesskeyid00000000000000000",
	R2_SECRET_ACCESS_KEY: "testsecretaccesskey000000000000000000000000000000000000000000000",
	R2_S3_ENDPOINT: "https://0123456789abcdef0123456789abcdef.eu.r2.cloudflarestorage.com",
	PAID_ARTIFACTS_BUCKET: "mailwoman-paid-test",
}

beforeAll(async () => {
	await applyMigrations(env.LICENSE_LEDGER)
})

interface Granted {
	status: string
	url: string
	expires: string
	bytes: number | null
}

async function app(options: { r2?: boolean } = {}) {
	const bindings: LicenseWorkerBindings = { ...env, ...(options.r2 === false ? {} : R2) }
	const signing = await envWithSigningKey(readEnv(bindings))
	const worker = signing.env
	const ledger = openLedger(env.LICENSE_LEDGER)

	const hono = createLicenseWorkerApp(worker, {
		signingStatus: () => "ok",
		email: { send: async () => ({ messageID: "msg" }) },
		ledger,
		stripe: stripeClient(worker),
		artifacts: CATALOG,
		now: () => OCT_21,
	})

	async function token(overrides: Partial<LicenseKeyPayload> = {}): Promise<string> {
		const payload: LicenseKeyPayload = {
			v: 1,
			kid: worker.LICENSE_SIGNING_KID,
			licensee: "Enterprise Ltd",
			issued: "2026-10-01",
			expires: "2027-10-01",
			scope: "all",
			terms: "LicenseRef-Commercial",
			...overrides,
		}

		return encodeLicenseKey(payload, worker.LICENSE_SIGNING_KEY_PEM)
	}

	function post(path: string, body: object) {
		return hono.request(path, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: stringifyJSON(body),
		})
	}

	return { worker, hono, ledger, token, post }
}

describe("the download route", () => {
	it("grants a presigned URL to a hand-issued token with no lid and records the download", async () => {
		const a = await app()
		const response = await a.post("/v1/downloads", { token: await a.token(), artifact: "tier:gb-streets" })

		expect(response.status).toBe(200)

		const body = (await response.json()) as Granted
		const url = new URL(body.url)

		expect(body).toMatchObject({ status: "granted", bytes: 1 })
		expect(url.host).toBe("0123456789abcdef0123456789abcdef.eu.r2.cloudflarestorage.com")
		expect(url.pathname).toBe("/mailwoman-paid-test/tiers/gb-streets/2026-10-01/gb-streets.db")
		expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/u)
		expect(body.expires).toBe(new Date(OCT_21 + 3600 * 1000).toISOString())

		const rows = await a.ledger
			.selectFrom("downloads")
			.select(["lid", "licensee", "artifact"])
			.where("licensee", "=", "Enterprise Ltd")
			.execute()

		expect(rows).toEqual([{ lid: null, licensee: "Enterprise Ltd", artifact: "tier:gb-streets" }])
	})

	it("checks a multi-artifact bundle's scope by its tier and finds its object by the full name", async () => {
		const a = await app()
		const token = await a.token({ scope: ["tier:us-streets"] })
		const response = await a.post("/v1/downloads", { token, artifact: "tier:us-streets/tiers/us-ca.db" })

		expect(response.status).toBe(200)
		expect(await response.json()).toMatchObject({ status: "granted", bytes: 2 })

		expect(
			new URL(((await response.json().catch(() => null)) as Granted | null)?.url ?? "https://x/").pathname
		).toBeDefined()
	})

	it("refuses an artifact outside the token's scope", async () => {
		const a = await app()
		const token = await a.token({ scope: ["@mailwoman/neural-weights-en-gb"] })
		const response = await a.post("/v1/downloads", { token, artifact: "tier:gb-streets" })

		expect(response.status).toBe(403)
		expect(await response.json()).toEqual({ error: "scope" })
	})

	it("refuses an expired token and a token this worker does not trust", async () => {
		const a = await app()

		const expired = await a.post("/v1/downloads", {
			token: await a.token({ expires: "2026-10-01" }),
			artifact: "tier:gb-streets",
		})

		expect(expired.status).toBe(403)
		expect(await expired.json()).toEqual({ error: "expired" })

		const forged = await a.post("/v1/downloads", { token: "mwl1.not.real", artifact: "tier:gb-streets" })

		expect(forged.status).toBe(403)
		expect(await forged.json()).toEqual({ error: "invalid" })
	})

	it("refuses a declared lid whose ledger state is lapsed, and grants it while active", async () => {
		const a = await app()

		const declared = (await (
			await a.post("/v1/declarations", {
				intent: "open-source",
				name: "Example Project",
				sourceURL: "https://github.com/example/project",
			})
		).json()) as { token: string; lid: string }

		const granted = await a.post("/v1/downloads", { token: declared.token, artifact: "tier:gb-streets" })

		expect(granted.status).toBe(200)

		await a.ledger
			.updateTable("declarations")
			.set({ license_state: "lapsed" })
			.where("lid", "=", declared.lid)
			.execute()

		const refused = await a.post("/v1/downloads", { token: declared.token, artifact: "tier:gb-streets" })

		expect(refused.status).toBe(403)
		expect(await refused.json()).toEqual({ error: "lapsed" })
	})

	it("answers 400 for an artifact outside the catalog", async () => {
		const a = await app()
		const response = await a.post("/v1/downloads", { token: await a.token(), artifact: "tier:nowhere" })

		expect(response.status).toBe(400)
		expect(await response.json()).toEqual({ error: "unknown artifact" })
	})

	it("answers 503 before the bucket is provisioned", async () => {
		const a = await app({ r2: false })
		const response = await a.post("/v1/downloads", { token: await a.token(), artifact: "tier:gb-streets" })

		expect(response.status).toBe(503)
		expect(await response.json()).toEqual({ error: "downloads unavailable" })
	})
})
