/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Every read and write against the ledger, so no route or handler holds a query. The idempotency the worker relies on
 *   lives in the schema's unique constraints — one event id, one subscription, one Checkout Session, one token per
 *   invoice — and the two writers that would collide (`recordEventOnce`, `insertToken`) answer or throw accordingly.
 */

import type { Ledger } from "#ledger/client"
import type { EmailState, LicenseRow, LicenseState, LicenseTokenRow, NewLicense, NewToken } from "#ledger/schema"

function nowISO(): string {
	return new Date().toISOString()
}

/**
 * Record a webhook event id. `"duplicate"` is Stripe redelivering an event this worker already acted on, and the caller
 * answers 200 with no further effect.
 */
export async function recordEventOnce(
	ledger: Ledger,
	event: { id: string; type: string; objectID: string }
): Promise<"recorded" | "duplicate"> {
	const result = await ledger
		.insertInto("stripe_events")
		.values({ event_id: event.id, type: event.type, object_id: event.objectID })
		.onConflict((conflict) => conflict.column("event_id").doNothing())
		.executeTakeFirst()

	return Number(result.numInsertedOrUpdatedRows ?? 0) > 0 ? "recorded" : "duplicate"
}

/**
 * Whether a webhook event id has been acted on. Read before the handler runs; `recordEventOnce` writes after it
 * succeeds.
 */
export async function eventRecorded(ledger: Ledger, eventID: string): Promise<boolean> {
	const row = await ledger
		.selectFrom("stripe_events")
		.select("event_id")
		.where("event_id", "=", eventID)
		.executeTakeFirst()

	return row !== undefined
}

export async function findLicenseBySubscription(
	ledger: Ledger,
	subscriptionID: string
): Promise<LicenseRow | undefined> {
	return ledger.selectFrom("licenses").selectAll().where("subscription_id", "=", subscriptionID).executeTakeFirst()
}

export async function findLicense(ledger: Ledger, lid: string): Promise<LicenseRow | undefined> {
	return ledger.selectFrom("licenses").selectAll().where("lid", "=", lid).executeTakeFirst()
}

export async function createLicense(ledger: Ledger, row: NewLicense): Promise<void> {
	await ledger.insertInto("licenses").values(row).execute()
}

export async function setPlanCode(ledger: Ledger, lid: string, planCode: string): Promise<void> {
	await ledger
		.updateTable("licenses")
		.set({ plan_code: planCode, updated_at: nowISO() })
		.where("lid", "=", lid)
		.execute()
}

export async function setLicenseState(
	ledger: Ledger,
	lid: string,
	state: LicenseState,
	also: { subscriptionState?: string; paymentState?: string } = {}
): Promise<void> {
	await ledger
		.updateTable("licenses")
		.set({
			license_state: state,
			updated_at: nowISO(),
			...(also.subscriptionState ? { subscription_state: also.subscriptionState } : {}),
			...(also.paymentState ? { payment_state: also.paymentState } : {}),
		})
		.where("lid", "=", lid)
		.execute()
}

/**
 * Read and clear the plaintext refresh secret so it is answered to exactly one claim. A read then a clear conditioned
 * on the value read: two claims racing both read it, but only the one whose clear lands a row answers it. (`RETURNING`
 * on the update alone would answer the cleared column, which is null.)
 */
export async function takePendingRefreshSecret(ledger: Ledger, lid: string): Promise<string | undefined> {
	const row = await ledger
		.selectFrom("licenses")
		.select("refresh_secret_pending")
		.where("lid", "=", lid)
		.executeTakeFirst()

	const pending = row?.refresh_secret_pending

	if (!pending) return undefined

	const cleared = await ledger
		.updateTable("licenses")
		.set({ refresh_secret_pending: null, updated_at: nowISO() })
		.where("lid", "=", lid)
		.where("refresh_secret_pending", "=", pending)
		.executeTakeFirst()

	return Number(cleared.numUpdatedRows ?? 0) > 0 ? pending : undefined
}

export async function findToken(ledger: Ledger, invoiceID: string): Promise<LicenseTokenRow | undefined> {
	return ledger.selectFrom("license_tokens").selectAll().where("invoice_id", "=", invoiceID).executeTakeFirst()
}

export async function findTokenLid(ledger: Ledger, invoiceID: string): Promise<string | undefined> {
	const row = await ledger
		.selectFrom("license_tokens")
		.select("lid")
		.where("invoice_id", "=", invoiceID)
		.executeTakeFirst()

	return row?.lid
}

/**
 * Throws on a second token for one invoice: the primary key is the idempotency the mint relies on.
 */
export async function insertToken(ledger: Ledger, row: NewToken): Promise<void> {
	await ledger.insertInto("license_tokens").values(row).execute()
}

export async function countTokens(ledger: Ledger, lid: string): Promise<number> {
	const row = await ledger
		.selectFrom("license_tokens")
		.select((eb) => eb.fn.countAll<number>().as("count"))
		.where("lid", "=", lid)
		.executeTakeFirst()

	return Number(row?.count ?? 0)
}

/**
 * The token that is current for a license: the one with the latest expiry.
 */
export async function currentToken(ledger: Ledger, lid: string): Promise<LicenseTokenRow | undefined> {
	return ledger
		.selectFrom("license_tokens")
		.selectAll()
		.where("lid", "=", lid)
		.orderBy("expires", "desc")
		.limit(1)
		.executeTakeFirst()
}

export async function setEmailState(
	ledger: Ledger,
	invoiceID: string,
	state: EmailState,
	messageID?: string
): Promise<void> {
	await ledger
		.updateTable("license_tokens")
		.set({ email_state: state, ...(messageID ? { email_message_id: messageID } : {}) })
		.where("invoice_id", "=", invoiceID)
		.execute()
}

/**
 * Tokens whose email has not been confirmed sent: `pending` covers a crash between the insert and the send, or between
 * the provider accepting the message and the ledger recording it; `failed` is a provider refusal. Both are re-sent
 * under the invoice id, which the provider deduplicates.
 */
export async function tokensAwaitingEmail(ledger: Ledger): Promise<LicenseTokenRow[]> {
	return ledger.selectFrom("license_tokens").selectAll().where("email_state", "in", ["pending", "failed"]).execute()
}

/**
 * Tokens whose email failed and were minted before `cutoff` (an ISO instant, the ledger's own timestamp shape): the
 * alert condition, since a failure that old has outlived the mint's attempt and is waiting on the six-hourly resend.
 */
export async function countFailedEmailsBefore(ledger: Ledger, cutoff: string): Promise<number> {
	const row = await ledger
		.selectFrom("license_tokens")
		.select((eb) => eb.fn.countAll<number>().as("count"))
		.where("email_state", "=", "failed")
		.where("created_at", "<", cutoff)
		.executeTakeFirst()

	return Number(row?.count ?? 0)
}

/**
 * The license a Checkout Session created and its current token, for the success page's claim.
 */
export async function findLicenseByCheckoutSession(ledger: Ledger, sessionID: string): Promise<LicenseRow | undefined> {
	return ledger.selectFrom("licenses").selectAll().where("checkout_session_id", "=", sessionID).executeTakeFirst()
}

/**
 * Every license, for the reconciliation pass. The table holds one row per customer, so the pass reads it whole rather
 * than asking Stripe what changed, which its subscription list cannot answer.
 */
export async function allLicenses(ledger: Ledger): Promise<LicenseRow[]> {
	return ledger.selectFrom("licenses").selectAll().orderBy("created_at", "asc").execute()
}
