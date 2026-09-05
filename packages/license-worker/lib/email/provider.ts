/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The one thing the worker asks of an email provider: deliver a license message once per invoice. The invoice id is
 *   the idempotency key, so a retried send after a failed ledger write is one message, not two.
 */

export interface LicenseEmail {
	to: string
	licensee: string
	token: string
	lid: string
	issued: string
	expires: string
	/**
	 * Present on the first message for a license only; the plaintext exists nowhere after that.
	 */
	refreshSecret?: string
}

export interface EmailProvider {
	send(message: LicenseEmail, idempotencyKey: string): Promise<{ messageID: string }>
}
