/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Cloudflare's email sending, through the worker's `send_email` binding: no API key, and the sending domain is the
 *   zone's. The binding takes no idempotency key, so a retried send after a failed ledger write can deliver twice; the
 *   ledger's `email_state` is what keeps that window to the crash between the provider's answer and the row.
 */

import type { EmailProvider } from "#email/provider"
import { licenseEmailSubject, renderLicenseEmail } from "#email/render"
import type { LicenseWorkerEnv } from "#env"

export function cloudflareEmailProvider(env: LicenseWorkerEnv, sender: SendEmail): EmailProvider {
	return {
		async send(message, idempotencyKey) {
			const result = await sender.send({
				from: env.EMAIL_FROM,
				to: message.to,
				subject: licenseEmailSubject(message),
				text: renderLicenseEmail(message, env.SITE_ORIGIN),
				headers: { "x-mailwoman-invoice": idempotencyKey },
			})

			return { messageID: result.messageId }
		},
	}
}
