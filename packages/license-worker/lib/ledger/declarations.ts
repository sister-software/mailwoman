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
	LicenseState,
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
 * Clear a declaration's plaintext refresh secret once the message that includes it has been sent.
 */
export async function clearDeclarationPendingSecret(ledger: Ledger, lid: string, at: string): Promise<void> {
	await ledger
		.updateTable("declarations")
		.set({ refresh_secret_pending: null, updated_at: at })
		.where("lid", "=", lid)
		.execute()
}

/**
 * Each emailed declaration's current issuance whose email is `pending` or `failed`.
 *
 * `pending` covers a crash between the mint and the send.
 * `failed` is a provider refusal.
 *
 * Only the highest `seq` per declaration is listed, so a resend sends the token that is current.
 */
export async function issuancesAwaitingEmail(
	ledger: Ledger
): Promise<Array<{ declaration: DeclarationRow; issuance: IssuanceRow }>> {
	const issuances = await ledger
		.selectFrom("issuances as current")
		.selectAll("current")
		.innerJoin("declarations", "declarations.lid", "current.lid")
		.where("declarations.email", "is not", null)
		.where("current.email_state", "in", ["pending", "failed"])
		.where(({ eb, selectFrom }) =>
			eb(
				"current.seq",
				"=",
				selectFrom("issuances as later")
					.select(({ fn }) => fn.max("later.seq").as("seq"))
					.whereRef("later.lid", "=", "current.lid")
			)
		)
		.orderBy("current.issuance_id")
		.execute()

	const listed: Array<{ declaration: DeclarationRow; issuance: IssuanceRow }> = []

	for (const issuance of issuances) {
		const declaration = await findDeclaration(ledger, issuance.lid)

		if (!declaration)
			throw new Error(`issuance ${issuance.issuance_id} names declaration ${issuance.lid}, which has no row`)

		listed.push({ declaration, issuance })
	}

	return listed
}

/**
 * Move a declared license from the state its caller read to another.
 *
 * The write applies only while the row still holds `transition.from`.
 * `"conflict"` means another writer changed the state after the caller read it,
 * and the row keeps that writer's values.
 */
export async function setDeclarationState(
	ledger: Ledger,
	lid: string,
	transition: { from: LicenseState; to: LicenseState },
	at: string
): Promise<"updated" | "conflict"> {
	const result = await ledger
		.updateTable("declarations")
		.set({ license_state: transition.to, updated_at: at })
		.where("lid", "=", lid)
		.where("license_state", "=", transition.from)
		.executeTakeFirst()

	return Number(result.numUpdatedRows ?? 0) > 0 ? "updated" : "conflict"
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
