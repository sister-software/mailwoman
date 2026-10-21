/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Every read and write against the declaration, issuance and download tables, so no route holds a query. The unique
 *   pair on `issuances(lid, seq)` and the partial unique index on an evaluation's email are the idempotency the routes
 *   rely on: `insertIssuance` inserts on no conflict and answers whether this caller's row landed, and a second
 *   evaluation for an address fails its insert with the unique violation the route turns into 409.
 */

import type { Ledger } from "#ledger/client"
import type {
	DeclarationRow,
	EmailState,
	IssuanceRow,
	NewDeclaration,
	NewDownload,
	NewIssuance,
	SourceVerification,
} from "#ledger/schema"

/**
 * Insert a declared license.
 *
 * A unique violation, such as a second evaluation for one address, throws.
 */
export async function createDeclaration(ledger: Ledger, row: NewDeclaration): Promise<void> {
	await ledger.insertInto("declarations").values(row).execute()
}

export async function findDeclaration(ledger: Ledger, lid: string): Promise<DeclarationRow | null> {
	return (await ledger.selectFrom("declarations").selectAll().where("lid", "=", lid).executeTakeFirst()) ?? null
}

export async function findDeclarationByClaim(ledger: Ledger, claimID: string): Promise<DeclarationRow | null> {
	return (
		(await ledger.selectFrom("declarations").selectAll().where("claim_id", "=", claimID).executeTakeFirst()) ?? null
	)
}

/**
 * The evaluation an address has already received, if any.
 */
export async function findEvaluationByEmail(ledger: Ledger, email: string): Promise<DeclarationRow | null> {
	return (
		(await ledger
			.selectFrom("declarations")
			.selectAll()
			.where("intent", "=", "evaluation")
			.where("email", "=", email)
			.executeTakeFirst()) ?? null
	)
}

/**
 * The issuance with the highest `seq` for a license, or `null` before the first.
 */
export async function currentIssuance(ledger: Ledger, lid: string): Promise<IssuanceRow | null> {
	return (
		(await ledger
			.selectFrom("issuances")
			.selectAll()
			.where("lid", "=", lid)
			.orderBy("seq", "desc")
			.limit(1)
			.executeTakeFirst()) ?? null
	)
}

/**
 * Insert an issuance unless one with the same `(lid, seq)` exists.
 *
 * `"present"` means another caller minted this ordinal first.
 */
export async function insertIssuance(ledger: Ledger, row: NewIssuance): Promise<"inserted" | "present"> {
	const result = await ledger
		.insertInto("issuances")
		.values(row)
		.onConflict((conflict) => conflict.columns(["lid", "seq"]).doNothing())
		.executeTakeFirst()

	return Number(result.numInsertedOrUpdatedRows ?? 0) > 0 ? "inserted" : "present"
}

export async function setIssuanceEmailState(
	ledger: Ledger,
	issuanceID: string,
	state: EmailState,
	messageID: string | null
): Promise<void> {
	await ledger
		.updateTable("issuances")
		.set({ email_state: state, email_message_id: messageID })
		.where("issuance_id", "=", issuanceID)
		.execute()
}

/**
 * Record what the source-URL check found, with the time of the check when it verified.
 */
export async function setDeclarationVerification(
	ledger: Ledger,
	lid: string,
	verification: SourceVerification,
	at: string
): Promise<void> {
	await ledger
		.updateTable("declarations")
		.set({ verification, verified_at: verification === "verified" ? at : null, updated_at: at })
		.where("lid", "=", lid)
		.execute()
}

export async function recordDownload(ledger: Ledger, row: NewDownload): Promise<void> {
	await ledger.insertInto("downloads").values(row).execute()
}
