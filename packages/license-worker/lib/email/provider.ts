/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The worker asks an email provider to deliver a license message under the invoice id. The provider uses that id
 *   as the idempotency key. Resend deduplicates a retried send after a failed ledger write. Cloudflare's binding can
 *   deliver that retry twice. The ledger's
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
	 * The agreement version the license was bought under.
	 * The message links its page.
	 */
	agreement: string
	/**
	 * Present while the plaintext refresh secret is pending.
	 *
	 * The first claim reads and clears it.
	 * A resend before that claim therefore includes the secret.
	 */
	refreshSecret: string | null
}

export interface EmailProvider {
	send(message: LicenseEmail, idempotencyKey: string): Promise<{ messageID: string }>
}
