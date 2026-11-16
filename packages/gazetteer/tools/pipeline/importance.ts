// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The importance build for one admin database.
 *
 *   The build copies the admin database, adds `place_importance` to the copy, stamps the admin
 *   file's md5 and size into `importance_source`, seals the copy and swaps it into place
 *   beside the admin database under the name `importanceDatabasePath` derives from that md5.
 *   The candidate build finds it there and refuses an importance database
 *   stamped with another admin database.
 *
 *   The scores come from Nominatim's `wikimedia-importance.csv.gz`, joined through
 *   the `concordances` table, with two scores per place.
 *
 *   The two-score split keeps `referential` (population-anchored, the ranking backbone)
 *   and `encyclopedic` (the Wikipedia join, NULL when there's no article) in their own
 *   columns, plus the legacy `importance` column via `blendImportance`.
 *   Schema, DDL, the referential derivation and the blend live in
 *   `@mailwoman/resolver-wof-sqlite/place-importance-schema` — read it before changing either score.
 *
 *   The admin database must already contain `concordances` and `place_population` for the fallback.
 *
 *   A Wikidata id can map to more than one current WOF place.
 *   The join isn't a function.
 *
 *   `importance/fanout.ts` resolves the candidates.
 *   It keeps coincident candidates, selects a winner when population distinguishes them
 *   and drops the id when neither condition applies.
 *
 *   Dropped places fall through to the population fallback instead of remaining blank.
 */

import { cacheRootPath } from "@mailwoman/core/data-root"
import { gunzipChunks } from "@mailwoman/core/fs/compression"
import { tryStat } from "@mailwoman/core/fs/readers/stat"
import { changeMode, copyFileTo, makeDirectories } from "@mailwoman/core/fs/writers"
import { referentialFromPopulation } from "@mailwoman/core/resolver"
import { CommandError } from "@mailwoman/core/scripting/command"
import { allRows, streamToDisk } from "@mailwoman/core/utils"
import { type FSTSourceIdentity, readWOFSourceIdentity } from "@mailwoman/resolver-wof-sqlite/fst/freshness"
import {
	importanceDatabasePath,
	type ImportanceSourceDatabase,
	writeImportanceSource,
} from "@mailwoman/resolver-wof-sqlite/importance-source"
import {
	blendImportance,
	createPlaceImportanceTable,
	type PlaceImportanceDatabase,
} from "@mailwoman/resolver-wof-sqlite/place-importance-schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { countRows } from "@mailwoman/sqlite/introspection"
import { recoverInterruptedBuilds, sealDatabase, swapDatabaseIntoPlace } from "@mailwoman/sqlite/sealed/db"
import { dirname, type PathBuilderLike } from "path-ts"
import { TextSpliterator } from "spliterator"
import { createReadStream } from "spliterator/node/fs"

import {
	emptyFanoutStats,
	type FanoutCandidate,
	type FanoutStats,
	recordFanout,
	resolveConcordanceFanout,
} from "#tools/pipeline/importance/fanout"

/**
 * Columns a Wikidata concordance row needs before it contains a usable mapping.
 */
const MIN_WIKIDATA_COLUMNS = 5

const IMPORTANCE_READ_HIGH_WATER_MARK = 64 * 1024

const IMPORTANCE_URL = "https://nominatim.org/data/wikimedia-importance.csv.gz"

export interface BuildImportanceOptions {
	/**
	 * The admin database to score.
	 */
	adminDB: PathBuilderLike
	/**
	 * A local copy of Nominatim's `wikimedia-importance.csv.gz`.
	 *
	 * @defaultValue The cached download under the cache root, fetched when absent.
	 */
	tsv?: PathBuilderLike
	onProgress?: (message: string) => void
}

export interface BuildImportanceResult {
	/**
	 * The sealed importance database, at `importanceDatabasePath(adminDB, admin.md5)`.
	 */
	out: string
	admin: FSTSourceIdentity
	encyclopedic: number
	referentialOnly: number
	total: number
	fanout: FanoutStats
}

/**
 * Build, seal and swap into place the importance database for `adminDB`.
 *
 * @throws When the admin database is missing or has no `concordances` table.
 */
export async function buildImportance(options: BuildImportanceOptions): Promise<BuildImportanceResult> {
	const progress = options.onProgress ?? (() => {})
	const adminPath = options.adminDB.toString()

	if (!(await tryStat(adminPath))) throw new CommandError(`Admin database not found: ${adminPath}`)

	// The stamp is the admin file's identity, the same md5 and size an FST records as its source.
	const admin = await readWOFSourceIdentity(adminPath)
	const out = importanceDatabasePath(adminPath, admin.md5)
	const dbPath = `${out}.tmp-${process.pid}`

	progress(`importance build for ${adminPath} (md5 ${admin.md5}) → ${out}`)

	// A failure before the swap leaves the `.tmp-<pid>` copy.
	// The next run removes it here.
	await recoverInterruptedBuilds(out)
	await copyFileTo(adminPath, dbPath)
	// The admin database is sealed, and its copy keeps the read-only mode.
	await changeMode(dbPath, 0o644)

	const kdb = new DatabaseClient<PlaceImportanceDatabase & ImportanceSourceDatabase>(dbPath, { open: true })

	// DDL goes through the Kysely schema-builder.
	// The hot insert loop stays on the raw `db` handle.
	progress("loading Wikidata concordances")

	let concordances: Map<string, number[]>
	const fanout = emptyFanoutStats()

	try {
		// Join `spr` for the geometry and population the fan-out guard needs.
		// Restrict rows to `is_current = 1` so a dead row cannot win a fan-out group.
		// Use DISTINCT because `concordances` contains duplicate (id, other_id) rows.
		const stmt = kdb.prepare(
			`SELECT DISTINCT c.other_id AS other_id, s.id AS id, s.placetype AS placetype,
			        s.latitude AS lat, s.longitude AS lon, COALESCE(p.population, 0) AS population
			 FROM concordances c
			 JOIN spr s ON s.id = c.id
			 LEFT JOIN place_population p ON p.id = s.id
			 WHERE c.other_source = 'wd:id' AND s.is_current = 1`
		)

		const rows = allRows<FanoutCandidate & { other_id: string }>(stmt)
		const grouped = new Map<string, FanoutCandidate[]>()

		for (const row of rows) {
			const existing = grouped.get(row.other_id)

			if (existing) {
				existing.push(row)
			} else {
				grouped.set(row.other_id, [row])
			}
		}

		concordances = new Map<string, number[]>()

		for (const [wikidataID, candidates] of grouped) {
			const resolution = resolveConcordanceFanout(candidates)
			recordFanout(fanout, candidates, resolution)

			if (resolution.keep.length) {
				concordances.set(wikidataID, resolution.keep)
			}
		}

		progress(`${grouped.size} unique Wikidata IDs from ${rows.length} concordance rows`)

		progress(
			`fan-out: ${fanout.fannedGroups} ids name >1 place — ` +
				`${fanout.coincidentGroups} coincident (kept whole), ` +
				`${fanout.populationGroups} resolved by population, ` +
				`${fanout.unresolvableGroups} dropped; ${fanout.droppedPlaces} places lose a mis-joined score`
		)
	} catch (error) {
		await kdb.destroy()

		if (error instanceof Error && error.message.includes("no such table")) {
			throw new CommandError("No concordances table found. Run `mailwoman gazetteer build admin` first.")
		}

		throw error
	}

	let gzPath = options.tsv?.toString()

	if (!gzPath) {
		gzPath = cacheRootPath("wikimedia-importance.csv.gz").toString()

		if (await tryStat(gzPath)) {
			progress(`using cached TSV: ${gzPath}`)
		} else {
			progress(`downloading ${IMPORTANCE_URL}`)

			await makeDirectories(dirname(gzPath))

			await streamToDisk({ url: IMPORTANCE_URL, destination: gzPath, context: "gazetteer importance" })

			progress(`downloaded to ${gzPath}`)
		}
	}

	progress("parsing Wikipedia importance TSV")

	const importanceMap = new Map<string, number>()
	let totalRows = 0

	const fileChunks = await createReadStream(gzPath, IMPORTANCE_READ_HIGH_WATER_MARK)

	// Set `crlf: true` because the Wikidata id is the last column.
	// A CRLF source would leave a stray `\r` on that value.
	for await (const line of TextSpliterator.fromAsync(gunzipChunks(fileChunks), { crlf: true })) {
		totalRows++

		if (totalRows === 1 && line.startsWith("language")) continue
		// oxlint-disable-next-line mailwoman/prefer-spliterator -- One line already streamed off `TextSpliterator` above.
		const parts = line.split("\t")

		if (parts.length < MIN_WIKIDATA_COLUMNS) continue

		const importance = Number(parts[3]!)
		const wikidataID = parts[4]!

		if (!wikidataID || !concordances.has(wikidataID)) continue

		if (Number.isNaN(importance)) continue

		const existing = importanceMap.get(wikidataID) ?? 0

		if (importance > existing) {
			importanceMap.set(wikidataID, importance)
		}
	}

	progress(`parsed ${totalRows.toLocaleString()} rows, ${importanceMap.size} matched Wikidata IDs`)

	// Each place gets one row with both scores in their own columns.
	// The legacy `importance` column comes from `blendImportance`, the bounded blend whose
	// cap keeps an article-floor score from outranking a population-attested town.
	progress("building place_importance (referential + encyclopedic)")

	await createPlaceImportanceTable(kdb)

	// A single WOF id can concord to multiple Wikidata ids.
	// A naive per-Wikidata insert would violate the `id` primary key.
	// Collapse to the maximum importance per WOF id first.
	const wofEncyclopedic = new Map<number, number>()

	for (const [wikidataID, importance] of importanceMap) {
		const wofIDs = concordances.get(wikidataID)

		if (!wofIDs) continue

		for (const wofID of wofIDs) {
			const existing = wofEncyclopedic.get(wofID) ?? 0

			if (importance > existing) {
				wofEncyclopedic.set(wofID, importance)
			}
		}
	}

	// Referential is population-anchored and independent of the Wikipedia join,
	// so every place with a population has one whether or not it has an article.
	const wofReferential = new Map<number, number>()

	try {
		const popRows = allRows<{
			id: number
			population: number
		}>(kdb.prepare("SELECT id, population FROM place_population"))

		for (const row of popRows) {
			const score = referentialFromPopulation(row.population)

			if (score > 0) {
				wofReferential.set(row.id, score)
			}
		}
	} catch {
		progress("no place_population table — every referential score will be 0")
	}

	const insertStmt = kdb.prepare(
		"INSERT INTO place_importance (id, referential, encyclopedic, importance) VALUES (?, ?, ?, ?)"
	)

	let encyclopedicCount = 0
	let referentialOnlyCount = 0
	// One row per place in the union of the two signals.
	// A place absent from both is absent from the table entirely, because a row of zeros
	// would assert that we measured no salience rather than that we performed no measurement.
	const allIDs = new Set<number>([...wofReferential.keys(), ...wofEncyclopedic.keys()])

	kdb.exec("BEGIN TRANSACTION")

	for (const wofID of allIDs) {
		const referential = wofReferential.get(wofID) ?? 0
		const encyclopedic = wofEncyclopedic.get(wofID) ?? null

		if (encyclopedic === null) {
			referentialOnlyCount++
		} else {
			encyclopedicCount++
		}

		// NULL, never 0, for a place with no article — the meaning-of-zero rule at the column level.
		insertStmt.run(wofID, referential, encyclopedic, blendImportance(referential, encyclopedic))
	}

	kdb.exec("COMMIT")

	// Read the total back with `select count(*)`.
	// The two counters describe what the run tried to do rather than what the table contains.
	const total = countRows(kdb, "place_importance")

	await writeImportanceSource(kdb, { path: adminPath, ...admin })
	await kdb.destroy() // closes the underlying `db` handle

	await sealDatabase(dbPath)
	await swapDatabaseIntoPlace(dbPath, out)

	return { out, admin, encyclopedic: encyclopedicCount, referentialOnly: referentialOnlyCount, total, fanout }
}
