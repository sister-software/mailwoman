/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The health route: the report's five words, the no-store header, and the email word turning on a failure that has
 *   outlived the hour, not on a fresh one.
 */

import { createLicenseWorkerApp } from "@mailwoman/license-worker/app"
import { readEnv } from "@mailwoman/license-worker/env"
import { openLedger } from "@mailwoman/license-worker/ledger/client"
import { createLicense, insertToken } from "@mailwoman/license-worker/ledger/licenses"
import { env } from "cloudflare:workers"
import { beforeAll, expect, test } from "vitest"

import { applyMigrations } from "../support/migrations.ts"

const NOW = Date.UTC(2026, 9, 1, 12)
const HOUR = 60 * 60 * 1000

beforeAll(async () => {
	await applyMigrations(env.LICENSE_LEDGER)
})

function app(now: () => number = () => NOW) {
	// Pinned rather than read from the sandbox vars, which flip with the deployment.
	return createLicenseWorkerApp(readEnv({ ...env, ISSUANCE_ENABLED: "false" }), {
		signingStatus: () => "unchecked",
		ledger: openLedger(env.LICENSE_LEDGER),
		email: { send: async () => ({ messageID: "msg_unused" }) },
		now,
	})
}

test("GET /health answers issuance, the environment's mode, a reachable ledger, the email word, and no-store", async () => {
	const res = await app().request("/health")

	expect(res.status).toBe(200)
	expect(res.headers.get("cache-control")).toBe("no-store")

	expect(await res.json()).toEqual({
		issuance: false,
		liveMode: false,
		signing: "unchecked",
		ledger: "ok",
		email: "ok",
	})
})

test("the email word turns failing on a failed email older than an hour, and stays ok on a fresh failure", async () => {
	const ledger = openLedger(env.LICENSE_LEDGER)

	await createLicense(ledger, {
		lid: "lic_health",
		subscription_id: "sub_health",
		customer_id: "cus_health",
		checkout_session_id: "cs_health",
		plan_code: "commercial-monthly-v1",
		agreement_version: "commercial-2026-10",
		licensee: "Health Ltd",
		email: "health@example.com",
		refresh_secret_sha256: "x".repeat(64),
		refresh_secret_pending: null,
	})

	const token = (invoiceID: string, minutesAgo: number) => ({
		invoice_id: invoiceID,
		lid: "lic_health",
		issued: "2026-10-01",
		expires: "2026-11-15",
		payload_json: "{}",
		token: `mwl1.${invoiceID}.sig`,
		email_state: "failed" as const,
		email_message_id: null,
		created_at: new Date(NOW - minutesAgo * 60 * 1000).toISOString(),
	})

	await insertToken(ledger, token("in_fresh", 10))

	expect(await (await app().request("/health")).json()).toMatchObject({ email: "ok" })

	await insertToken(ledger, token("in_stale", 90))

	expect(await (await app().request("/health")).json()).toMatchObject({ email: "failing" })

	// The same ledger read two hours later says the fresh one has aged into the alert too; one is enough either way.
	expect(await (await app(() => NOW + 2 * HOUR).request("/health")).json()).toMatchObject({ email: "failing" })
})
