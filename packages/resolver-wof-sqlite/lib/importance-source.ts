// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Which admin database an importance build was made from.
 *
 *   `mailwoman gazetteer importance` copies an admin database and adds `place_importance` to the copy.
 *   It stamps the admin file's md5 and size into the copy's `importance_source` table, the same
 *   identity an FST stamps as `sourceDBMD5` and `sourceDBBytes` ({@linkcode readWOFSourceIdentity}).
 *
 *   The copy is written beside the admin database at {@linkcode importanceDatabasePath},
 *   a name derived from the admin md5, so the candidate build finds the importance build for
 *   its admin database by hashing that database, and checks the stamp before reading a score.
 */

import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { tableExists } from "@mailwoman/sqlite/introspection"
import type { Kysely } from "kysely"
import { basename, dirname, resolvePathBuilder, type PathBuilderLike } from "path-ts"

import { type FSTSourceIdentity, readWOFSourceIdentity } from "#fst/freshness"

/**
 * The one row of `importance_source`: the admin database the importance build copied.
 */
export interface ImportanceSourceTable {
	/**
	 * The admin path as the importance build was given it.
	 */
	admin_path: string
	/**
	 * The admin file's md5 as lowercase hex.
	 */
	admin_md5: string
	/**
	 * The admin file's size in bytes.
	 */
	admin_bytes: number
}

export interface ImportanceSourceDatabase {
	importance_source: ImportanceSourceTable
}

/**
 * The admin database an importance build records, read back from its stamp.
 */
export interface ImportanceAdminSource extends FSTSourceIdentity {
	path: string
}

/**
 * The count of md5 hex characters in the importance file name.
 * The stamp inside the file holds the whole digest.
 */
const NAME_DIGEST_LENGTH = 12

/**
 * Where the importance build for an admin database lives: beside it,
 * under a name built from the admin's md5.
 *
 * `admin-global-priority.db` with md5 `6a0c2736…` gives `admin-global-priority-importance-6a0c2736xxxx.db`.
 */
export function importanceDatabasePath(adminDB: PathBuilderLike, adminMD5: string): string {
	const name = basename(adminDB.toString(), ".db")

	return resolvePathBuilder(dirname(adminDB.toString()))(
		`${name}-importance-${adminMD5.slice(0, NAME_DIGEST_LENGTH)}.db`
	).toString()
}

/**
 * Create `importance_source` and write the admin identity into it, replacing any earlier row.
 */
export async function writeImportanceSource(
	db: Kysely<ImportanceSourceDatabase>,
	source: ImportanceAdminSource
): Promise<void> {
	await db.schema.dropTable("importance_source").ifExists().execute()

	await db.schema
		.createTable("importance_source")
		.addColumn("admin_path", "text", (c) => c.notNull())
		.addColumn("admin_md5", "text", (c) => c.notNull())
		.addColumn("admin_bytes", "integer", (c) => c.notNull())
		.execute()

	await db
		.insertInto("importance_source")
		.values({ admin_path: source.path, admin_md5: source.md5, admin_bytes: source.bytes })
		.execute()
}

/**
 * Read the admin identity an importance build stamped.
 *
 * Returns `null` only when the file has no `importance_source` table.
 * Such a file is an importance build that predates the stamp.
 *
 * @throws When the file is missing, or when the table holds other than one row.
 */
export async function readImportanceSource(importanceDB: PathBuilderLike): Promise<ImportanceAdminSource | null> {
	if (!(await pathExists(importanceDB))) {
		throw new Error(`importance source: ${importanceDB} not found`)
	}

	using db = new DatabaseClient<ImportanceSourceDatabase>(importanceDB, { readOnly: true })

	if (!tableExists(db, "importance_source")) return null

	const rows = await db.selectFrom("importance_source").selectAll().execute()

	if (rows.length !== 1) {
		throw new Error(`importance source: ${importanceDB} holds ${rows.length} importance_source rows, expected 1`)
	}

	const [row] = rows

	return { path: row!.admin_path, md5: row!.admin_md5, bytes: Number(row!.admin_bytes) }
}

/**
 * The importance build a reader uses, with its own md5 for a manifest or a report.
 */
export interface ResolvedImportance {
	path: string
	md5: string
}

/**
 * A refusal from {@linkcode resolveImportanceForAdmin}.
 * Its message gives the admin path and the importance path.
 */
export class ImportanceSourceError extends Error {
	constructor(message: string) {
		super(message)

		this.name = "ImportanceSourceError"
	}
}

/**
 * Find the importance build that belongs with `adminDB` and check its stamp.
 *
 * Every reader of importance scores finds its file here, from the admin database it reads.
 * Without `importanceDB` the file is the one {@linkcode importanceDatabasePath} gives for the admin md5.
 * A given `importanceDB` is checked the same way.
 *
 * @throws {ImportanceSourceError} When no importance build exists for the admin database,
 * when the file has no `importance_source` stamp, or when its stamp records another admin database.
 */
export async function resolveImportanceForAdmin(
	adminDB: PathBuilderLike,
	importanceDB?: PathBuilderLike
): Promise<ResolvedImportance> {
	if (!(await pathExists(adminDB))) {
		throw new ImportanceSourceError(`admin ${adminDB} does not exist, so no importance build can be matched to it.`)
	}

	const admin = await readWOFSourceIdentity(adminDB)
	const path = (importanceDB ?? importanceDatabasePath(adminDB, admin.md5)).toString()
	const rebuild = `mailwoman gazetteer importance --admin ${adminDB}`

	if (!(await pathExists(path))) {
		throw new ImportanceSourceError(
			`no importance build for admin ${adminDB} (md5 ${admin.md5}): ${path} does not exist. ` +
				`Build it with \`${rebuild}\`.`
		)
	}

	const stamped = await readImportanceSource(path)

	if (!stamped) {
		throw new ImportanceSourceError(
			`importance ${path} records no admin database (no importance_source table), so it cannot be ` +
				`matched to admin ${adminDB} (md5 ${admin.md5}). Rebuild it with \`${rebuild}\`.`
		)
	}

	if (stamped.md5 !== admin.md5 || stamped.bytes !== admin.bytes) {
		throw new ImportanceSourceError(
			`importance ${path} was built from admin ${stamped.path} (md5 ${stamped.md5}, ` +
				`${stamped.bytes} bytes), not admin ${adminDB} (md5 ${admin.md5}, ${admin.bytes} bytes). ` +
				`Rebuild it with \`${rebuild}\`.`
		)
	}

	return { path, md5: (await readWOFSourceIdentity(path)).md5 }
}

/**
 * {@linkcode resolveImportanceForAdmin} for a report that goes on without scores.
 *
 * A refusal comes back as its message, and the message gives both paths.
 * The report states that message as the reason it read no scores.
 *
 * @throws Any error other than an {@linkcode ImportanceSourceError}.
 */
export async function resolveImportanceOrRefusal(
	adminDB: PathBuilderLike
): Promise<(ResolvedImportance & { refusal: null }) | { path: null; md5: null; refusal: string }> {
	try {
		return { ...(await resolveImportanceForAdmin(adminDB)), refusal: null }
	} catch (error) {
		if (error instanceof ImportanceSourceError) return { path: null, md5: null, refusal: error.message }

		throw error
	}
}
