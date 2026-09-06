/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The one thing the worker asks of an email provider: deliver a license message under the invoice id. The id rides
 *   as the idempotency key, and a provider that honours one (Resend) deduplicates a retried send after a failed
 *   ledger write; one that does not (Cloudflare's binding) can deliver that retry twice, and the ledger's
 *   `email_state` is what keeps the window to that one crash.
 */

export interface LicenseEmail {
	to: string
	licensee: string
	token: string
	lid: string
	issued: string
	expires: string
	/**
	 * Present while the license's plaintext secret is still pending, which is until the first claim reads and clears it:
	 * the first message carries it, and so does a re-send before that claim.
	 */
	refreshSecret?: string
}

export interface EmailProvider {
	send(message: LicenseEmail, idempotencyKey: string): Promise<{ messageID: string }>
}
