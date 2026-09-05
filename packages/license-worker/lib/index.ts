/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The Worker export. `readEnv` runs per request and is cheap; a placeholder var answers 503 for every request rather
 *   than letting one route work while another mints. The ledger, the email provider and the signing self-test are built
 *   once per isolate: the self-test signs and verifies a probe token, which is worth doing once, not per request.
 */

import type { ExportedHandler } from "@cloudflare/workers-types"

import { type AppDependencies, createLicenseWorkerApp } from "#app"
import { resendProvider } from "#email/resend"
import { type LicenseWorkerBindings, type LicenseWorkerEnv, readEnv } from "#env"
import { openLedger } from "#ledger/client"
import { reconcile } from "#reconcile"
import type { SigningStatusReport } from "#routes/health"
import { type SigningSelfTest, signingSelfTest } from "#signing"
import { stripeClient } from "#stripe/client"

const MISCONFIGURED = JSON.stringify({ error: "worker misconfigured" })

/**
 * How far back each reconciliation pass lists paid invoices: a week, against a six-hour cron, so a pass that fails
 * leaves nothing unminted before the next one.
 */
const RECONCILE_WINDOW_SECONDS = 7 * 24 * 3600

interface IsolateState {
	deps: AppDependencies
	selfTest: Promise<SigningSelfTest>
}

let isolate: IsolateState | undefined

function isolateState(env: LicenseWorkerEnv): IsolateState {
	if (isolate) return isolate

	let signing: SigningStatusReport = "unchecked"

	const selfTest = signingSelfTest(env).then((result) => {
		signing = result.status

		if (result.status !== "ok") {
			console.error(`signing self-test: ${result.reason}`)
		}

		return result
	})

	isolate = {
		selfTest,
		deps: {
			signingStatus: () => signing,
			ledger: openLedger(env.LICENSE_LEDGER),
			email: resendProvider(env),
		},
	}

	return isolate
}

function misconfigured(): Response {
	return new Response(MISCONFIGURED, {
		status: 503,
		headers: { "content-type": "application/json", "cache-control": "no-store" },
	})
}

const handler: ExportedHandler<LicenseWorkerBindings> = {
	async fetch(request, bindings) {
		let env: LicenseWorkerEnv

		try {
			env = readEnv(bindings)
		} catch {
			return misconfigured() as never
		}

		const state = isolateState(env)

		// The first request in an isolate waits for the self-test so `/v1` never answers from an unchecked key.
		await state.selfTest

		return createLicenseWorkerApp(env, state.deps).fetch(request as never) as never
	},

	async scheduled(_controller, bindings, ctx) {
		const env = readEnv(bindings)
		const state = isolateState(env)
		const selfTest = await state.selfTest

		// A worker that would refuse to mint over HTTP refuses to mint on a schedule too; the report says why.
		if (selfTest.status !== "ok") {
			console.error(JSON.stringify({ reconcile: "skipped", reason: selfTest.reason }))

			return
		}

		ctx.waitUntil(
			reconcile(
				env,
				{ stripe: stripeClient(env), ledger: state.deps.ledger, email: state.deps.email },
				{ sinceSeconds: RECONCILE_WINDOW_SECONDS }
			).then((report) => console.log(JSON.stringify({ reconcile: report })))
		)
	},
}

export default handler
