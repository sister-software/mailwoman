// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The Overture Divisions part of the candidate gazetteer, written as its own file for the ODbL 4.6 offer.
 *
 *   `candidate.db` is a Collective Database.
 *   Its Overture Divisions part is the rows whose `spr_id` falls in the Overture id range,
 *   their closure and interval rows, and `overture_wof_match`.
 *
 *   That part is a Derivative Database of Overture Divisions under ODbL 1.0,
 *   so a published gazetteer must offer it in machine-readable form (ODbL 4.6),
 *   and the rest of the file keeps its own terms (ODbL 4.5(a)).
 *
 *   The part qualifies because no other row depends on it: the Overture step leaves each WOF record as
 *   WOF wrote it (`admin/sources/overture.ts`), and the candidate build's cross-row passes read an Overture
 *   row only to change another Overture row (`@mailwoman/resolver-wof-sqlite/build/candidate`).
 *
 *   This module copies the part out of a built candidate, unchanged, into a sealed
 *   database stamped with the ODbL terms and the Overture credit.
 *   The Northern Ireland postcode rows are offered the same way at
 *   https://huggingface.co/datasets/sister-software/mailwoman-osm-ni-postcode-fold.
 */

import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { removePathIfPresent } from "@mailwoman/core/fs/writers"
import { md5File } from "@mailwoman/core/hash"
import { LayerTier } from "@mailwoman/core/layers"
import { repoRootPath } from "@mailwoman/core/paths"
import { GEONAMES_ID_BASE, OVERTURE_ID_BASE } from "@mailwoman/core/resolver/synthetic-id-ranges"
import type { CandidateDatabase } from "@mailwoman/resolver-wof-sqlite/candidate/schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { tableExists } from "@mailwoman/sqlite/introspection"
import { sealDatabase } from "@mailwoman/sqlite/sealed/db"
import { basename, type PathBuilderLike } from "path-ts"

import { buildSHA, contributingLayerManifest, stampLayerManifest } from "#tools/pipeline/stamp-manifest"

/**
 * The SPDX expression that governs the Overture Divisions part.
 *
 * Overture's attribution page gives its Divisions theme `License for theme: ODbL`.
 */
export const OVERTURE_PART_LICENSE = "ODbL-1.0"

/**
 * The credit Overture asks for on its Divisions theme.
 * The theme is derived largely from OpenStreetMap.
 */
export const OVERTURE_PART_ATTRIBUTION = "© OpenStreetMap contributors, Overture Maps Foundation"

/**
 * Where a published gazetteer offers its Overture Divisions part under ODbL 4.6.
 */
export const OVERTURE_PART_OFFER_URL =
	"https://huggingface.co/datasets/sister-software/mailwoman-overture-divisions"

/**
 * The statement a gazetteer manifest makes about its Overture Divisions part.
 */
export const OVERTURE_PART_NOTICE =
	`A Collective Database (ODbL 1.0 section 4.5(a)): the Overture Divisions rows, ids ${OVERTURE_ID_BASE} to ` +
	`${GEONAMES_ID_BASE - 1}, with their closure and interval rows and the overture_wof_match table, are an ` +
	`independent part under ${OVERTURE_PART_LICENSE}, ${OVERTURE_PART_ATTRIBUTION}, offered by itself at ` +
	`${OVERTURE_PART_OFFER_URL}. The other rows keep their own terms.`

/**
 * The candidate tables the part copies, each with the predicate that selects the part's rows.
 *
 * A closure row belongs to the part when its child does.
 * Its WOF ancestor id and name are a reference to a row outside the part.
 */
const PART_TABLES: ReadonlyArray<{ table: keyof CandidateDatabase & string; where: string }> = [
	{ table: "candidate", where: `spr_id >= ${OVERTURE_ID_BASE} AND spr_id < ${GEONAMES_ID_BASE}` },
	{ table: "candidate_ancestor", where: `spr_id >= ${OVERTURE_ID_BASE} AND spr_id < ${GEONAMES_ID_BASE}` },
	{ table: "candidate_interval", where: `spr_id >= ${OVERTURE_ID_BASE} AND spr_id < ${GEONAMES_ID_BASE}` },
	{ table: "overture_wof_match", where: "1" },
	// The code tables decode `country_id` and `placetype_id`, so they travel whole.
	{ table: "country_codes", where: "1" },
	{ table: "placetype_codes", where: "1" },
]

export interface BuildOverturePartOptions {
	/**
	 * The built candidate gazetteer to copy the part out of.
	 */
	candidateDB: PathBuilderLike
	/**
	 * The output database, a staging path.
	 * It is replaced when present.
	 */
	out: PathBuilderLike
	/**
	 * The Overture release the candidate's admin gazetteer read its divisions from, recorded as the part's source vintage.
	 */
	overtureRelease: string
	/**
	 * The part's version, such as the gazetteer version it is offered beside.
	 */
	version: string
	now?: Date
	onPhase?: (phase: string, detail?: string) => void
}

export interface BuildOverturePartResult {
	out: string
	/**
	 * Rows copied per table.
	 */
	rows: Record<string, number>
	/**
	 * Distinct Overture places in the copied candidate rows.
	 */
	places: number
	candidateMD5: string
	sealed: boolean
}

/**
 * Copy the Overture Divisions part out of `candidateDB` into its own sealed database under ODbL 1.0.
 *
 * Each table keeps the candidate's DDL, so a reader of `candidate.db` reads the part the same way.
 *
 * @throws When the candidate has no `overture_wof_match` table.
 * Such a candidate was built before the Overture step kept the part apart, so it holds no independent part to offer.
 */
export async function buildOverturePart(options: BuildOverturePartOptions): Promise<BuildOverturePartResult> {
	const phase = options.onPhase ?? (() => {})
	const now = options.now ?? new Date()
	const out = options.out.toString()

	if (!(await pathExists(options.candidateDB))) throw new Error(`candidate DB not found: ${options.candidateDB}`)

	phase("md5", options.candidateDB.toString())
	const candidateMD5 = await md5File(options.candidateDB)

	await removePathIfPresent(out)

	const rows: Record<string, number> = {}
	let places: number

	{
		using src = new DatabaseClient<CandidateDatabase>(options.candidateDB, { readOnly: true })

		if (!tableExists(src, "overture_wof_match")) {
			throw new Error(
				`buildOverturePart: ${options.candidateDB} has no overture_wof_match table. It was built before the ` +
					`Overture step kept its rows apart, so its Overture rows are not an independent part to offer.`
			)
		}

		using db = new DatabaseClient<CandidateDatabase>(out)

		db.exec("PRAGMA page_size=8192; PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF;")

		for (const { table, where } of PART_TABLES) {
			const ddl = src.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as
				| { sql: string | null }
				| undefined

			if (!ddl?.sql) throw new Error(`buildOverturePart: ${options.candidateDB} has no ${table} table`)

			db.exec(ddl.sql)

			const columns = (src.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
				(column) => column.name
			)

			const insert = db.prepare(
				`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`
			)

			phase("copy", table)
			db.exec("BEGIN")
			let copied = 0

			for (const row of src.prepare(`SELECT ${columns.join(", ")} FROM ${table} WHERE ${where}`).iterate()) {
				insert.run(...columns.map((column) => (row as Record<string, string | number | null>)[column] ?? null))

				copied++
			}

			db.exec("COMMIT")
			rows[table] = copied
		}

		places = Number(
			(db.prepare("SELECT count(DISTINCT spr_id) AS n FROM candidate").get() as { n: number } | undefined)?.n ?? 0
		)

		phase("vacuum")
		db.exec("VACUUM")
	}

	phase("layer-manifest")

	await stampLayerManifest(
		out,
		contributingLayerManifest({
			name: "candidate-overture-divisions",
			version: options.version,
			// ODbL 1.0 is share-alike on a Derivative Database.
			tier: LayerTier.BuildLocal,
			license: OVERTURE_PART_LICENSE,
			attribution: `${OVERTURE_PART_ATTRIBUTION}. The Overture Divisions part of the candidate gazetteer, offered under ODbL 1.0 section 4.6 at ${OVERTURE_PART_OFFER_URL}.`,
			source: `${basename(options.candidateDB.toString())} md5 ${candidateMD5}`,
			sourceVintage: `overture-divisions=${options.overtureRelease}`,
			buildCmd: "mailwoman gazetteer build overture-part",
			buildSHA: buildSHA(repoRootPath()),
			createdAt: now.toISOString(),
			spineKeys: { wofID: "spr_id" },
			sourceRecords: rows,
		})
	)

	phase("seal")
	await sealDatabase(out)

	return { out, rows, places, candidateMD5, sealed: true }
}
