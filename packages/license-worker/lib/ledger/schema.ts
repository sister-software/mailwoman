/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The ledger's table types, one interface per table in `migrations/0001_ledger.sql`. The migration is the DDL by
 *   Wrangler's contract; these are the read/write contracts Kysely types every query against. A column the migration
 *   defaults is `Generated`, so an insert may omit it and a select always carries it.
 */

import type { Generated, Insertable, Selectable } from "kysely"

/**
 * The four states a license moves through. `review` is a partial refund awaiting an operator; it reads `active` to the
 * public status route because the customer paid.
 */
export const LicenseState = {
	Active: "active",
	Lapsed: "lapsed",
	Revoked: "revoked",
	Review: "review",
} as const

export type LicenseState = (typeof LicenseState)[keyof typeof LicenseState]

export type EmailState = "pending" | "sent" | "failed"

export interface LicensesTable {
	lid: string
	subscription_id: string
	customer_id: string
	checkout_session_id: string
	plan_code: string
	agreement_version: string
	licensee: string
	email: string
	refresh_secret_sha256: string
	refresh_secret_pending: string | null
	subscription_state: Generated<string>
	payment_state: Generated<string>
	license_state: Generated<LicenseState>
	created_at: Generated<string>
	updated_at: Generated<string>
}

export interface LicenseTokensTable {
	invoice_id: string
	lid: string
	issued: string
	expires: string
	payload_json: string
	token: string
	email_state: Generated<EmailState>
	email_message_id: string | null
	created_at: Generated<string>
}

export interface StripeEventsTable {
	event_id: string
	type: string
	object_id: string
	received_at: Generated<string>
	outcome: Generated<string>
}

export interface LedgerDatabase {
	licenses: LicensesTable
	license_tokens: LicenseTokensTable
	stripe_events: StripeEventsTable
}

export type LicenseRow = Selectable<LicensesTable>

export type LicenseTokenRow = Selectable<LicenseTokensTable>

export type NewLicense = Insertable<LicensesTable>

export type NewToken = Insertable<LicenseTokensTable>
