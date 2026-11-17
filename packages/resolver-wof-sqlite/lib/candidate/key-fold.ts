// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file Extra folds a `candidate.db` applies to every `name_key`, recorded in the artifact so its reader
 *   folds each query key the same way.
 *
 *   A fold changes which keys exist, so the build and the reader must agree on it. The build applies it
 *   as a post-pass over the materialized `candidate` table, and the reader reads the recorded folds once.
 */

import type { DatabaseClient } from "@mailwoman/sqlite/client"

import type { CandidateDatabase } from "#candidate/schema"
import { hasTable } from "#sqlite-utils"
import { type NameKey, withArabicLetterVariantsFolded } from "#street/normalize"

/**
 * The table that lists the folds applied to the artifact's `name_key` column, one row per fold.
 * An artifact without it applies none.
 */
export const CANDIDATE_KEY_FOLD_TABLE = "candidate_key_fold"

/**
 * The folds a candidate build can apply on top of `normalizeLocalityForKey`.
 */
export const CandidateKeyFold = {
	/**
	 * {@link withArabicLetterVariantsFolded}: hamza, madda and vowel marks dropped,
	 * `ى` written `ي`, `ة` written `ه`.
	 */
	ArabicLetterVariants: "arabic-letter-variants",
} as const

export type CandidateKeyFold = (typeof CandidateKeyFold)[keyof typeof CandidateKeyFold]

/**
 * The key function of each fold, and the GLOB that selects the keys it can change.
 */
const FOLDS: Readonly<Record<CandidateKeyFold, { fold: (key: NameKey) => NameKey; glob: string }>> = {
	[CandidateKeyFold.ArabicLetterVariants]: { fold: withArabicLetterVariantsFolded, glob: "*[؀-ۿ]*" },
}

/**
 * The counts {@link applyCandidateKeyFold} reports.
 */
export interface CandidateKeyFoldResult {
	/**
	 * Rows whose key the fold changed.
	 */
	rekeyed: number
	/**
	 * Rekeyed rows dropped because the folded key already held the same place under the same scope.
	 */
	merged: number
}

/**
 * Rewrites every `candidate.name_key` the fold changes and records the fold
 * in {@link CANDIDATE_KEY_FOLD_TABLE}.
 *
 * A row whose folded key already exists for the same place, scope, placetype and rank is merged into it.
 * It runs on a writable copy or inside a build, never on a published artifact.
 */
export async function applyCandidateKeyFold(
	db: DatabaseClient<CandidateDatabase>,
	foldName: CandidateKeyFold
): Promise<CandidateKeyFoldResult> {
	const { fold, glob } = FOLDS[foldName]
	const sqlName = `mw_key_fold_${foldName.replaceAll("-", "_")}`

	db.function(sqlName, { deterministic: true }, (key) => fold(String(key) as NameKey))

	const changed = `name_key GLOB '${glob}' AND ${sqlName}(name_key) <> name_key`
	const { n: rekeyed } = db.prepare(`SELECT count(*) AS n FROM candidate WHERE ${changed}`).get() as { n: number }

	db.exec("BEGIN")

	const inserted = db
		.prepare(
			"INSERT OR IGNORE INTO candidate SELECT " +
				`${sqlName}(name_key), country_id, region_id, placetype_id, neg_rank, spr_id, name, latitude, longitude, ` +
				"min_lat, min_lon, max_lat, max_lon, population, is_primary, importance, name_role " +
				`FROM candidate WHERE ${changed}`
		)
		.run()

	db.prepare(`DELETE FROM candidate WHERE ${changed}`).run()

	await db.schema
		.createTable(CANDIDATE_KEY_FOLD_TABLE)
		.ifNotExists()
		.addColumn("fold", "text", (c) => c.primaryKey())
		.execute()

	db.prepare(`INSERT OR IGNORE INTO ${CANDIDATE_KEY_FOLD_TABLE} (fold) VALUES (?)`).run(foldName)
	db.exec("COMMIT")

	return { rekeyed, merged: rekeyed - Number(inserted.changes) }
}

/**
 * The query-key function an artifact's recorded folds call for: identity when it records none.
 *
 * A fold name the reader doesn't know raises, because a key that misses that
 * fold would miss every row the fold rewrote.
 */
export function candidateQueryKeyFold(db: DatabaseClient<CandidateDatabase>): (key: NameKey) => NameKey {
	if (!hasTable(db, CANDIDATE_KEY_FOLD_TABLE)) return (key) => key

	const names = (
		db.prepare(`SELECT fold FROM ${CANDIDATE_KEY_FOLD_TABLE} ORDER BY fold`).all() as { fold: string }[]
	).map((row) => row.fold)

	const folds = names.map((name) => {
		const known = FOLDS[name as CandidateKeyFold]

		if (!known) throw new Error(`candidate.db records the key fold ${name}, which this reader doesn't implement`)

		return known.fold
	})

	return (key) => {
		let folded = key

		for (const fold of folds) {
			folded = fold(folded)
		}

		return folded
	}
}
