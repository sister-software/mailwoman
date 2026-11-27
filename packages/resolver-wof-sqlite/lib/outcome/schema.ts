// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The outcome tables of `docs/engineering/reference/outcome-kinds.mdx`,
 *   compiled into a database from one pinned revision of the definitions.
 *
 *   A record's set is the join of the two: the defaults of its placetype, and its explicit assertions.
 *   `outcome_manifest` is the database's `outcomes` block, the revision and spec hash both were built from.
 *
 *   `landmarks.db` keys its records by Wikidata item, so its assertions sit in `landmark_outcome`.
 */

import { createOutcomeEvidenceTable } from "@mailwoman/core/outcome/evidence"
import type { CompiledOutcomeSpec, OutcomeSpecPin } from "@mailwoman/core/outcome/spec"
import type { DatabaseClient } from "@mailwoman/sqlite/client"
import type { Kysely } from "kysely"

import { hasTable } from "#sqlite-utils"

/**
 * One placetype default.
 */
export interface OutcomeDefaultTable {
	placetype: string
	outcome_id: number
}

/**
 * One explicit assertion on one record.
 */
export interface RecordOutcomeTable {
	spr_id: number
	outcome_id: number
	/**
	 * 1 when a source denies the member while the record holds it, else 0.
	 */
	contested: number
}

/**
 * One explicit assertion on one `landmarks.db` place.
 */
export interface LandmarkOutcomeTable {
	qid: string
	outcome_id: number
	contested: number
}

/**
 * The single row naming the definitions revision the tables were compiled from.
 */
export type OutcomeManifestTable = OutcomeSpecPin

export interface OutcomeDatabase {
	outcome_default: OutcomeDefaultTable
	record_outcome: RecordOutcomeTable
	outcome_manifest: OutcomeManifestTable
}

export interface LandmarkOutcomeDatabase {
	outcome_default: OutcomeDefaultTable
	landmark_outcome: LandmarkOutcomeTable
	outcome_manifest: OutcomeManifestTable
}

/**
 * The tables every outcome-aware gazetteer database holds, in the order a reader names them in a refusal.
 */
const OUTCOME_TABLES = ["outcome_default", "record_outcome", "outcome_manifest"] as const

/**
 * The placetype every `poi.db` row holds, so the join with `outcome_default` gives each row `venue`.
 */
export const POI_ROW_PLACETYPE = "venue"

/**
 * The two tables every outcome-aware database shares, whichever key its assertions use.
 */
interface OutcomeSharedDatabase {
	outcome_default: OutcomeDefaultTable
	outcome_manifest: OutcomeManifestTable
}

/**
 * The members of a handle {@link writeOutcomeDefaults} uses, so a handle over any
 * schema that holds the shared tables passes without a cast.
 */
type OutcomeSharedHandle = Pick<Kysely<OutcomeSharedDatabase>, "insertInto" | "schema">

/**
 * Create the outcome tables, write the pinned revision and every placetype default of
 * the spec, and create the assertion table the database keys its records by.
 *
 * @returns The count of `outcome_default` rows.
 */
export async function writeOutcomeDefaults(
	db: OutcomeSharedHandle,
	spec: CompiledOutcomeSpec,
	pin: OutcomeSpecPin,
	recordKey: "spr_id" | "qid" = "spr_id"
): Promise<number> {
	const table = createOutcomeEvidenceTable(spec)

	await db.schema
		.createTable("outcome_default")
		.addColumn("placetype", "text", (c) => c.notNull())
		.addColumn("outcome_id", "integer", (c) => c.notNull())
		.addPrimaryKeyConstraint("outcome_default_pk", ["placetype", "outcome_id"])
		.execute()

	await db.schema
		.createTable("outcome_manifest")
		.addColumn("revision", "text", (c) => c.notNull())
		.addColumn("sha256", "text", (c) => c.notNull())
		.execute()

	await db.schema
		.createTable(recordKey === "qid" ? "landmark_outcome" : "record_outcome")
		.addColumn(recordKey, recordKey === "qid" ? "text" : "integer", (c) => c.notNull())
		.addColumn("outcome_id", "integer", (c) => c.notNull())
		.addColumn("contested", "integer", (c) => c.notNull())
		.addPrimaryKeyConstraint("outcome_assertion_pk", [recordKey, "outcome_id"])
		.execute()

	await db.insertInto("outcome_manifest").values(pin).execute()

	const defaults = Object.entries(spec.defaults).flatMap(([placetype, members]) =>
		members.map((member) => ({ placetype, outcome_id: table.idOf(member) }))
	)

	await db.insertInto("outcome_default").values(defaults).execute()

	return defaults.length
}

/**
 * The outcome tables a database lacks, empty when it holds all three.
 *
 * A database built before the outcome design holds none, and a request that filters
 * or orders by outcome against it is refused with these names.
 *
 * @public
 */
export function missingOutcomeTables<DB>(db: DatabaseClient<DB>): string[] {
	return OUTCOME_TABLES.filter((table) => !hasTable(db, table))
}

/**
 * The `outcomes` block a database was compiled against, or `null` when it predates the tables.
 *
 * @public
 */
export function readOutcomeManifest<DB>(db: DatabaseClient<DB>): OutcomeSpecPin | null {
	if (!hasTable(db, "outcome_manifest")) return null

	const row = db.prepare("SELECT revision, sha256 FROM outcome_manifest").get()

	if (!row) {
		throw new Error("outcome_manifest holds zero rows; the database's outcome tables have no pinned revision.")
	}

	return { revision: String(row.revision), sha256: String(row.sha256) }
}
