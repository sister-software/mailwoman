/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { openLedger } from "@mailwoman/license-worker/ledger/client"
import {
	createLicense,
	currentToken,
	findLicenseBySubscription,
	insertToken,
	recordEventOnce,
	setLicenseState,
	takePendingRefreshSecret,
} from "@mailwoman/license-worker/ledger/licenses"
import { LicenseState } from "@mailwoman/license-worker/ledger/schema"
import { env } from "cloudflare:workers"
import { beforeAll, expect, test } from "vitest"

import { applyMigrations } from "../support/migrations.ts"

beforeAll(async () => {
	await applyMigrations(env.LICENSE_LEDGER)
})

function license(suffix: string) {
	return {
		lid: `lic_test00000000000000000${suffix}`,
		subscription_id: `sub_${suffix}`,
		customer_id: `cus_${suffix}`,
		checkout_session_id: `cs_test_${suffix}`,
		plan_code: "commercial-monthly-v1",
		agreement_version: "commercial-2026-10",
		licensee: "Example Ltd",
		email: "ops@example.com",
		refresh_secret_sha256: "0".repeat(64),
		refresh_secret_pending: "secret",
	}
}

test("an event id records once; the second write is a duplicate with no effect", async () => {
	const ledger = openLedger(env.LICENSE_LEDGER)

	expect(await recordEventOnce(ledger, { id: "evt_1", type: "invoice.paid", objectID: "in_1" })).toBe("recorded")
	expect(await recordEventOnce(ledger, { id: "evt_1", type: "invoice.paid", objectID: "in_1" })).toBe("duplicate")
})

test("a license is found by subscription; the current token is the one with the latest expiry", async () => {
	const ledger = openLedger(env.LICENSE_LEDGER)
	const row = license("a")

	await createLicense(ledger, row)
	expect((await findLicenseBySubscription(ledger, row.subscription_id))?.license_state).toBe(LicenseState.Active)

	await insertToken(ledger, {
		invoice_id: "in_a1",
		lid: row.lid,
		issued: "2026-10-01",
		expires: "2026-11-15",
		payload_json: "{}",
		token: "mwl1.a.a",
	})

	await insertToken(ledger, {
		invoice_id: "in_a2",
		lid: row.lid,
		issued: "2026-11-01",
		expires: "2026-12-15",
		payload_json: "{}",
		token: "mwl1.b.b",
	})

	expect((await currentToken(ledger, row.lid))?.invoice_id).toBe("in_a2")
})

test("a second token for one invoice is refused by the primary key", async () => {
	const ledger = openLedger(env.LICENSE_LEDGER)
	const row = license("b")

	await createLicense(ledger, row)

	const token = { invoice_id: "in_b1", lid: row.lid, issued: "2026-10-01", expires: "2026-11-15", payload_json: "{}" }

	await insertToken(ledger, { ...token, token: "mwl1.a.a" })
	await expect(insertToken(ledger, { ...token, token: "mwl1.c.c" })).rejects.toThrow(/UNIQUE|constraint/iu)
})

test("state transitions write the license, subscription and payment states", async () => {
	const ledger = openLedger(env.LICENSE_LEDGER)
	const row = license("c")

	await createLicense(ledger, row)

	await setLicenseState(ledger, row.lid, LicenseState.Revoked, {
		subscriptionState: "canceled",
		paymentState: "refunded",
	})

	expect(await findLicenseBySubscription(ledger, row.subscription_id)).toMatchObject({
		license_state: "revoked",
		subscription_state: "canceled",
		payment_state: "refunded",
	})
})

test("the pending refresh secret is answered to exactly one taker, and the stored digest stays", async () => {
	const ledger = openLedger(env.LICENSE_LEDGER)
	const row = license("d")

	await createLicense(ledger, row)

	expect(await takePendingRefreshSecret(ledger, row.lid)).toBe("secret")
	expect(await takePendingRefreshSecret(ledger, row.lid)).toBeUndefined()

	expect(await findLicenseBySubscription(ledger, row.subscription_id)).toMatchObject({
		refresh_secret_pending: null,
		refresh_secret_sha256: "0".repeat(64),
	})
})
