/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Resend over its HTTP API. The `Idempotency-Key` header is the invoice id, so a retried send is one message. The body
 *   names the licensee, the dates, the token, and the commands to run; it never names an amount or a Stripe id.
 */

import type { EmailProvider, LicenseEmail } from "#email/provider"
import type { LicenseWorkerEnv } from "#env"

const RESEND_ENDPOINT = "https://api.resend.com/emails"

export function resendProvider(env: LicenseWorkerEnv): EmailProvider {
	return {
		async send(message, idempotencyKey) {
			const response = await fetch(RESEND_ENDPOINT, {
				method: "POST",
				headers: {
					authorization: `Bearer ${env.EMAIL_API_KEY}`,
					"content-type": "application/json",
					"idempotency-key": idempotencyKey,
				},
				body: JSON.stringify({
					from: env.EMAIL_FROM,
					to: [message.to],
					subject: `Your Mailwoman commercial license (${message.issued} to ${message.expires})`,
					text: renderLicenseEmail(message, env.SITE_ORIGIN),
				}),
			})

			if (!response.ok) throw new Error(`email provider answered ${response.status}`)

			const body = (await response.json()) as { id: string }

			return { messageID: body.id }
		},
	}
}

function renderLicenseEmail(message: LicenseEmail, siteOrigin: string): string {
	const refresh = message.refreshSecret
		? [
				"Your refresh secret (shown once; keep it with the key):",
				message.refreshSecret,
				"",
				"Fetch the current key any time:",
				`  mailwoman license refresh --lid ${message.lid} --secret <secret>`,
			]
		: [
				"Fetch the current key any time with the refresh secret from your first email:",
				`  mailwoman license refresh --lid ${message.lid} --secret <secret>`,
			]

	return [
		`Licensee: ${message.licensee}`,
		`License id: ${message.lid}`,
		`Valid: ${message.issued} to ${message.expires} (UTC, inclusive)`,
		"",
		"Your license key:",
		message.token,
		"",
		"Configure it:",
		`  export MAILWOMAN_LICENSE_KEY="${message.token}"`,
		"  mailwoman license verify --online",
		"",
		...refresh,
		"",
		`Manage billing: ${siteOrigin}/license`,
	].join("\n")
}
