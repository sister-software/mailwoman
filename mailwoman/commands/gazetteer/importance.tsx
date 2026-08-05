/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman gazetteer importance` — build the `place_importance` table in a WOF SQLite database
 *   from Nominatim's Wikipedia importance data. Downloads `wikimedia-importance.csv.gz`, joins
 *   through the `concordances` table, and writes importance scores for each WOF place with a
 *   Wikidata mapping, then layers a population-derived fallback for places Wikipedia doesn't
 *   cover.
 *
 *   The table is added to the `--db` IN PLACE (the original `scripts/build-importance.ts` behavior):
 *   the WOF DB must already carry `concordances` (and, for the fallback, `place_population`) — run
 *   `mailwoman gazetteer build admin` first. Step progress streams to stderr; the final tally lands on
 *   stdout.
 *
 *   THE JOIN IS NOT A FUNCTION (#1497). 7,061 Wikidata ids name more than one current WOF place, and
 *   before 2026-08-05 all of them received the same score — `Q18125` (Manchester, England) put 0.7397
 *   on a 53-person Minnesota village. `gazetteer-pipeline/importance-fanout.ts` decides which
 *   candidate a fanned-out id actually means (coincident → keep all, since 71.4% of the fan-out is
 *   one place modelled at several placetypes; else decisive population → keep the winner; else drop
 *   the id). Its module header carries the survey and the worked cases; read it before changing the
 *   rule. Dropped places are not left blank — they fall through to the population fallback below,
 *   which is what they had before Wikipedia importance existed.
 */

import { createReadStream, existsSync, writeFileSync } from "node:fs"
import { get as httpsGet } from "node:https"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { createGunzip } from "node:zlib"

import { DatabaseClient } from "@mailwoman/core/kysley/client"
import { Box, Text } from "ink"
import { TextSpliterator } from "spliterator"
import zod from "zod"

import { commandError, type CommandComponent, useCommandTask } from "../../cli-kit/index.ts"
import {
	emptyFanoutStats,
	type FanoutCandidate,
	recordFanout,
	resolveConcordanceFanout,
} from "../../gazetteer-pipeline/importance-fanout.ts"

/**
 * Permanent redirect.
 */
const HTTP_MOVED_PERMANENTLY = 301

/**
 * Temporary redirect.
 */
const HTTP_FOUND = 302

/**
 * Columns a Wikidata concordance row needs before it carries a usable mapping.
 */
const MIN_WIKIDATA_COLUMNS = 5

const IMPORTANCE_URL = "https://nominatim.org/data/wikimedia-importance.csv.gz"

const OptionsSchema = zod.object({
	db: zod.string().describe("WOF SQLite DB to add place_importance to (must carry the concordances table)"),
	tsv: zod.string().optional().describe("Pre-downloaded wikimedia-importance.csv.gz. Default: download to $TMPDIR"),
})

export { OptionsSchema as options }

function downloadToFile(url: string, dest: string): Promise<void> {
	return new Promise((resolve, reject) => {
		httpsGet(url, (res) => {
			if (res.statusCode === HTTP_MOVED_PERMANENTLY || res.statusCode === HTTP_FOUND) {
				const location = res.headers.location

				if (location) {
					httpsGet(location, (res2) => {
						const chunks: Buffer[] = []
						res2.on("data", (chunk) => chunks.push(chunk))

						res2.on("end", () => {
							writeFileSync(dest, Buffer.concat(chunks))
							resolve()
						})

						res2.on("error", reject)
					}).on("error", reject)

					return
				}
			}

			const chunks: Buffer[] = []
			res.on("data", (chunk) => chunks.push(chunk))

			res.on("end", () => {
				writeFileSync(dest, Buffer.concat(chunks))
				resolve()
			})

			res.on("error", reject)
		}).on("error", reject)
	})
}

const GazetteerImportance: CommandComponent<typeof OptionsSchema> = ({ options }) => {
	const state = useCommandTask(async () => {
		const dbPath = options.db
		const tsvPath = options.tsv
		const t0 = performance.now()

		if (!existsSync(dbPath)) throw commandError(`Database not found: ${dbPath}`)

		const db = new DatabaseSync(dbPath, { open: true })
		// DDL via the Kysely schema-builder; the hot INSERT loop below stays on the raw `db` handle.
		const kdb = new DatabaseClient({ database: db })

		// Step 1: Load Wikidata concordances from WOF
		console.error("Loading Wikidata concordances from WOF...")

		let concordances: Map<string, number[]>
		const fanout = emptyFanoutStats()

		try {
			// Joins `spr` for the geometry + population the fan-out guard needs, and restricts to
			// `is_current = 1` — a deprecated place is not in any consumer's read path, and leaving it
			// in would let a dead row win a fan-out group. DISTINCT because `concordances` carries
			// duplicate (id, other_id) rows (Q18125 appears twice for the same place).
			const stmt = db.prepare(
				`SELECT DISTINCT c.other_id AS other_id, s.id AS id, s.placetype AS placetype,
				        s.latitude AS lat, s.longitude AS lon, COALESCE(p.population, 0) AS population
				 FROM concordances c
				 JOIN spr s ON s.id = c.id
				 LEFT JOIN place_population p ON p.id = s.id
				 WHERE c.other_source = 'wd:id' AND s.is_current = 1`
			)

			const rows = stmt.all() as unknown as Array<FanoutCandidate & { other_id: string }>
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

			console.error(`  ${grouped.size} unique Wikidata IDs from ${rows.length} concordance rows`)

			console.error(
				`  fan-out: ${fanout.fannedGroups} ids name >1 place — ` +
					`${fanout.coincidentGroups} coincident (kept whole), ` +
					`${fanout.populationGroups} resolved by population, ` +
					`${fanout.unresolvableGroups} dropped; ${fanout.droppedPlaces} places lose a mis-joined score`
			)
		} catch (error) {
			if (error instanceof Error && error.message.includes("no such table")) {
				throw commandError("No concordances table found. Run `mailwoman gazetteer build admin` first.")
			}

			throw error
		}

		// Step 2: Get or download the Wikipedia importance TSV
		let gzPath = tsvPath

		if (!gzPath) {
			gzPath = join(tmpdir(), "wikimedia-importance.csv.gz")

			if (existsSync(gzPath)) {
				console.error(`  Using cached TSV: ${gzPath}`)
			} else {
				console.error(`  Downloading ${IMPORTANCE_URL}...`)

				await downloadToFile(IMPORTANCE_URL, gzPath)

				console.error(`  Downloaded to ${gzPath}`)
			}
		}

		// Step 3: Stream-parse TSV, filtering to matching Wikidata IDs
		console.error("Parsing Wikipedia importance TSV...")

		const importanceMap = new Map<string, number>()
		let totalRows = 0

		const gunzip = createGunzip()
		const fileStream = createReadStream(gzPath)

		// crlf: the wikidata id is the last column — a CRLF source would leave a stray \r on it.
		for await (const line of TextSpliterator.fromAsync(fileStream.pipe(gunzip), { crlf: true })) {
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

		console.error(`  Parsed ${totalRows.toLocaleString()} rows, ${importanceMap.size} matched Wikidata IDs`)

		// Step 4: Build place_importance table
		console.error("Building place_importance table...")

		await kdb.schema.dropTable("place_importance").ifExists().execute()

		await kdb.schema
			.createTable("place_importance")
			.addColumn("id", "integer", (c) => c.primaryKey())
			.addColumn("importance", "real", (c) => c.notNull())
			.execute()

		const insertStmt = db.prepare("INSERT INTO place_importance (id, importance) VALUES (?, ?)")
		let importanceCount = 0

		// A single WOF id can concord to MULTIPLE wikidata ids (the current global DB's concordances carry
		// such multiplicities; a naive per-wikidata insert double-inserts the wof id and violates the `id`
		// primary key). Collapse to the MAX importance per wof id first, then insert once each.
		const wofImportance = new Map<number, number>()

		for (const [wikidataID, importance] of importanceMap) {
			const wofIDs = concordances.get(wikidataID)

			if (!wofIDs) continue

			for (const wofID of wofIDs) {
				const existing = wofImportance.get(wofID) ?? 0

				if (importance > existing) {
					wofImportance.set(wofID, importance)
				}
			}
		}

		db.exec("BEGIN TRANSACTION")

		for (const [wofID, importance] of wofImportance) {
			insertStmt.run(wofID, importance)

			importanceCount++
		}

		db.exec("COMMIT")

		// Step 5: Population fallback for places without Wikipedia data
		console.error("Adding population fallback for unmatched places...")

		let fallbackCount = 0

		try {
			const popStmt = db.prepare("SELECT id, population FROM place_population")
			const fallbackInsert = db.prepare("INSERT OR IGNORE INTO place_importance (id, importance) VALUES (?, ?)")
			const popRows = popStmt.all() as unknown as Array<{ id: number; population: number }>
			db.exec("BEGIN TRANSACTION")

			for (const row of popRows) {
				if (row.population > 0) {
					const pseudoImportance = Math.min(1, Math.log2(1 + row.population / 1000) / 14)
					// `changes` is 0 when OR IGNORE skipped a place that already has a Wikipedia score.
					// Counting the ATTEMPT instead over-reported the 2026-08-05 build by 110,637 —
					// `Total in place_importance: 1656663` against a table holding 1,546,026.
					fallbackCount += fallbackInsert.run(row.id, pseudoImportance).changes > 0 ? 1 : 0
				}
			}

			db.exec("COMMIT")
		} catch {
			console.error("  No place_population table — skipping fallback")
		}

		// The total is READ BACK, never derived by adding the two counters. The counters describe what
		// this run tried to do; the table is what it did, and when those disagreed nobody noticed
		// because the derived number looked plausible. `SELECT count(*)` cannot drift.
		const total = (db.prepare("SELECT count(*) AS c FROM place_importance").get() as unknown as { c: number }).c

		await kdb.destroy() // closes the underlying `db` handle

		const elapsed = ((performance.now() - t0) / 1000).toFixed(1)

		return [
			`place_importance: ${dbPath}  (${elapsed}s)`,
			`Wikipedia importance: ${importanceCount} places`,
			`Population fallback:  ${fallbackCount} places`,
			`Total in place_importance: ${total} places`,
			`Fan-out guard: ${fanout.droppedPlaces} places dropped from ${fanout.unresolvableGroups + fanout.populationGroups} ambiguous Wikidata ids (#1497)`,
		]
	})

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	if (state.status === "done") {
		return (
			<Box flexDirection="column">
				{state.result.map((line, i) => (
					<Text key={i} color={i === 0 ? "green" : undefined}>
						{i === 0 ? "✓ " : "  "}
						{line}
					</Text>
				))}
			</Box>
		)
	}

	return null // step progress streams to stderr until the tally lands
}

export default GazetteerImportance
