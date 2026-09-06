/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { createLicenseWorkerApp } from "@mailwoman/license-worker/app"
import { readEnv } from "@mailwoman/license-worker/env"
import { openLedger } from "@mailwoman/license-worker/ledger/client"
import { env } from "cloudflare:workers"
import { expect, test } from "vitest"

test("GET /health answers issuance, the environment's mode, a reachable ledger, and no-store", async () => {
	const app = createLicenseWorkerApp(readEnv(env), {
		signingStatus: () => "unchecked",
		ledger: openLedger(env.LICENSE_LEDGER),
		email: { send: async () => ({ messageID: "msg_unused" }) },
	})

	const res = await app.request("/health")

	expect(res.status).toBe(200)
	expect(res.headers.get("cache-control")).toBe("no-store")
	expect(await res.json()).toEqual({ issuance: false, liveMode: false, signing: "unchecked", ledger: "ok" })
})
