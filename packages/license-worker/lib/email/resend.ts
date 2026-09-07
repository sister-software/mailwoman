/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Resend over its HTTP API, the provider when the worker has no `send_email` binding. The `Idempotency-Key` header is
 *   the invoice id, so a retried send is one message.
 */

import type { EmailProvider } from "#email/provider"
import { licenseEmailSubject, renderLicenseEmail, renderLicenseEmailHTML } from "#email/render"
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
					subject: licenseEmailSubject(message),
					text: renderLicenseEmail(message, env.SITE_ORIGIN),
					html: renderLicenseEmailHTML(message, env.SITE_ORIGIN, env.EMAIL_FROM),
				}),
			})

			if (!response.ok) throw new Error(`email provider answered ${response.status}`)

			const body = (await response.json()) as { id: string }

			return { messageID: body.id }
		},
	}
}
