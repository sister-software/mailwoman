/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The Worker export. `readEnv` runs per request and is cheap; a placeholder var answers 503 for every request rather
 *   than letting one route work while another mints.
 */

import type { ExportedHandler } from "@cloudflare/workers-types"

import { createLicenseWorkerApp } from "#app"
import { type LicenseWorkerBindings, readEnv } from "#env"

const MISCONFIGURED = JSON.stringify({ error: "worker misconfigured" })

const handler: ExportedHandler<LicenseWorkerBindings> = {
	fetch(request, bindings) {
		let env

		try {
			env = readEnv(bindings)
		} catch {
			return new Response(MISCONFIGURED, {
				status: 503,
				headers: { "content-type": "application/json", "cache-control": "no-store" },
			}) as never
		}

		return createLicenseWorkerApp(env).fetch(request as never) as never
	},
}

export default handler
