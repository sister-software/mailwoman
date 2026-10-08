/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The ledger's table types, one interface per table in `migrations/` (0001_ledger.sql plus later renames). The migrations are the DDL by
 *   Wrangler's interface. these are the read/write interfaces Kysely types every query against. A column the migration
 *   defaults is `Generated`, so an insert may omit it and a select always includes it.
 */

import type { Generated, Insertable, Selectable } from "kysely"

/**
 * The four states a license moves through, as the `license_state` column's check constraint spells them.
 *
 * What moves a license between them is `policy.ts`.
 */
export const LicenseState = {
	Active: "active",
	Lapsed: "lapsed",
	Revoked: "revoked",
	Review: "review",
} as const

export type LicenseState = (typeof LicenseState)[keyof typeof LicenseState]

export type EmailState = "pending" | "sent" | "failed"

interface LicensesTable {
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

interface LicenseTokensTable {
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

interface StripeEventsTable {
	event_id: string
	type: string
	object_id: string
	received_at: Generated<string>
	result: Generated<string>
}

export interface LedgerDatabase {
	licenses: LicensesTable
	license_tokens: LicenseTokensTable
	stripe_events: StripeEventsTable
}

/**
 * How a column's TypeScript type reads in the DDL.
 *
 * - `"required"` is `NOT NULL` (or the primary key) with no default.
 * - `"nullable"` admits `NULL` and has no default.
 * - `"generated"` has a default, so an insert may omit it.
 */
export type LedgerColumnKind = "required" | "nullable" | "generated"

type ColumnKindOf<Value> = Value extends { readonly __insert__: unknown }
	? "generated"
	: null extends Value
		? "nullable"
		: "required"

type LedgerColumns = {
	[Table in keyof LedgerDatabase]: {
		[Column in keyof LedgerDatabase[Table]]-?: ColumnKindOf<LedgerDatabase[Table][Column]>
	}
}

/**
 * Every ledger column and its kind, checked against the table interfaces above.
 *
 * The migrations stay the DDL.
 * A test applies them and compares the result to this table, so an interface that
 * drifts from the migrations fails the worker's tests.
 */
export const LEDGER_COLUMNS: LedgerColumns = {
	licenses: {
		lid: "required",
		subscription_id: "required",
		customer_id: "required",
		checkout_session_id: "required",
		plan_code: "required",
		agreement_version: "required",
		licensee: "required",
		email: "required",
		refresh_secret_sha256: "required",
		refresh_secret_pending: "nullable",
		subscription_state: "generated",
		payment_state: "generated",
		license_state: "generated",
		created_at: "generated",
		updated_at: "generated",
	},
	license_tokens: {
		invoice_id: "required",
		lid: "required",
		issued: "required",
		expires: "required",
		payload_json: "required",
		token: "required",
		email_state: "generated",
		email_message_id: "nullable",
		created_at: "generated",
	},
	stripe_events: {
		event_id: "required",
		type: "required",
		object_id: "required",
		received_at: "generated",
		result: "generated",
	},
}

export type LicenseRow = Selectable<LicensesTable>

export type LicenseTokenRow = Selectable<LicenseTokensTable>

export type NewLicense = Insertable<LicensesTable>

export type NewToken = Insertable<LicenseTokensTable>
