/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman gazetteer importance` — build the `place_importance` table in a WOF SQLite database.
 *   Downloads Nominatim's `wikimedia-importance.csv.gz`, joins it through the `concordances` table,
 *   and writes TWO scores per place.
 *
 *   THE TWO-SCORE SPLIT (ROAD_TO_V9 §2 R1, ratified 2026-08-06). This command used to write one
 *   column, filled by Wikipedia where the join landed and by a population-derived pseudo-score
 *   everywhere else — a conflation nothing downstream could take apart, which is how encyclopedic
 *   importance became the de-facto ranking signal for a geocoder whose users are asking "which place
 *   do I mean". It now writes `referential` (population-anchored, the ranking backbone) and
 *   `encyclopedic` (the Wikipedia join, NULL when there is no article) in their own columns, plus
 *   the legacy `importance` column via `blendImportance` — the bounded blend the #28 fame consumer
 *   ranks on. Schema, DDL, the referential derivation and the blend live in
 *   `@mailwoman/resolver-wof-sqlite/place-importance-schema` — read it before changing either score.
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

import { gunzipChunks } from "@mailwoman/core/fs/compression"
import { tryStat } from "@mailwoman/core/fs/readers"
import { makeDirectories } from "@mailwoman/core/fs/writers"
import { allRows, cacheRootPath, streamToDisk } from "@mailwoman/core/utils"
import type { PlaceImportanceDatabase } from "@mailwoman/resolver-wof-sqlite/place-importance-schema"
import { countRows } from "@mailwoman/sqlite/introspection"
import { Box, Text } from "ink"
import { dirname } from "path-ts"
import { createReadStream } from "spliterator/node/fs"

import {
	CommandError,
	type CommandSpec,
	CommandTaskResult,
	type ParsedCommandComponent,
	useCommandTask,
} from "#cli-kit"
import type { FanoutCandidate } from "#gazetteer-pipeline/importance-fanout"

/**
 * Permanent redirect.
 */

/**
 * Temporary redirect.
 */

/**
 * Columns a Wikidata concordance row needs before it carries a usable mapping.
 */
const MIN_WIKIDATA_COLUMNS = 5

/**
 * Chunk size used while streaming the compressed Wikimedia importance table.
 */
const IMPORTANCE_READ_HIGH_WATER_MARK = 64 * 1024

const IMPORTANCE_URL = "https://nominatim.org/data/wikimedia-importance.csv.gz"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "importance",
	description: "Add place importance to a WOF database",
	options: {
		db: { type: "string", required: true, description: "WOF SQLite database" },
		tsv: { type: "string", description: "Pre-downloaded Wikimedia importance data" },
	},
} as const satisfies CommandSpec

interface Options {
	db: string
	tsv?: string
}

const GazetteerImportance: ParsedCommandComponent<Options> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { DatabaseClient } = await import("@mailwoman/sqlite/client")

		const { blendImportance, createPlaceImportanceTable, referentialFromPopulation } =
			await import("@mailwoman/resolver-wof-sqlite/place-importance-schema")

		const { TextSpliterator } = await import("spliterator")

		const { emptyFanoutStats, recordFanout, resolveConcordanceFanout } =
			await import("#gazetteer-pipeline/importance-fanout")

		const dbPath = options.db
		const tsvPath = options.tsv
		const t0 = performance.now()

		if (!(await tryStat(dbPath))) throw new CommandError(`Database not found: ${dbPath}`)

		const kdb = new DatabaseClient<PlaceImportanceDatabase>(dbPath, { open: true })

		// DDL via the Kysely schema-builder; the hot INSERT loop below stays on the raw `db` handle.

		// Step 1: Load Wikidata concordances from WOF
		console.error("Loading Wikidata concordances from WOF...")

		let concordances: Map<string, number[]>
		const fanout = emptyFanoutStats()

		try {
			// Joins `spr` for the geometry + population the fan-out guard needs, and restricts to
			// `is_current = 1` — a deprecated place is not in any consumer's read path, and leaving it
			// in would let a dead row win a fan-out group. DISTINCT because `concordances` carries
			// duplicate (id, other_id) rows (Q18125 appears twice for the same place).
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

			console.error(`  ${grouped.size} unique Wikidata IDs from ${rows.length} concordance rows`)

			console.error(
				`  fan-out: ${fanout.fannedGroups} ids name >1 place — ` +
					`${fanout.coincidentGroups} coincident (kept whole), ` +
					`${fanout.populationGroups} resolved by population, ` +
					`${fanout.unresolvableGroups} dropped; ${fanout.droppedPlaces} places lose a mis-joined score`
			)
		} catch (error) {
			if (error instanceof Error && error.message.includes("no such table")) {
				throw new CommandError("No concordances table found. Run `mailwoman gazetteer build admin` first.")
			}

			throw error
		}

		// Step 2: Get or download the Wikipedia importance TSV
		let gzPath = tsvPath

		if (!gzPath) {
			gzPath = cacheRootPath("wikimedia-importance.csv.gz")

			if (await tryStat(gzPath)) {
				console.error(`  Using cached TSV: ${gzPath}`)
			} else {
				console.error(`  Downloading ${IMPORTANCE_URL}...`)

				await makeDirectories(dirname(gzPath))

				await streamToDisk({ url: IMPORTANCE_URL, destination: gzPath, context: "gazetteer importance" })

				console.error(`  Downloaded to ${gzPath}`)
			}
		}

		// Step 3: Stream-parse TSV, filtering to matching Wikidata IDs
		console.error("Parsing Wikipedia importance TSV...")

		const importanceMap = new Map<string, number>()
		let totalRows = 0

		const fileChunks = await createReadStream(gzPath, IMPORTANCE_READ_HIGH_WATER_MARK)

		// crlf: the wikidata id is the last column — a CRLF source would leave a stray \r on it.
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

		console.error(`  Parsed ${totalRows.toLocaleString()} rows, ${importanceMap.size} matched Wikidata IDs`)

		// Step 4: Build place_importance at the TWO-SCORE SPLIT schema (ROAD_TO_V9 §2 R1).
		//
		// Before the split this ran as two passes over one column: Wikipedia scores, then an
		// `INSERT OR IGNORE` population fallback for whatever Wikipedia missed. That made the column
		// a conflation nothing downstream could take apart — which is how encyclopedic importance
		// became the de-facto ranking signal. Now each place gets ONE row carrying both scores in
		// their own columns, and the legacy `importance` column is written by `blendImportance` — the
		// bounded blend whose cap keeps an article-floor score from outranking a population-attested
		// town (see the constant's docstring for the bracketing contests).
		console.error("Building place_importance table (referential + encyclopedic)...")

		await createPlaceImportanceTable(kdb)

		// A single WOF id can concord to MULTIPLE wikidata ids (the current global DB's concordances carry
		// such multiplicities; a naive per-wikidata insert double-inserts the wof id and violates the `id`
		// primary key). Collapse to the MAX importance per wof id first, then insert once each.
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

		// Referential is population-anchored and independent of the Wikipedia join — every place with a
		// population carries one whether or not it has an article.
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
			console.error("  No place_population table — every referential score will be 0")
		}

		const insertStmt = kdb.prepare(
			"INSERT INTO place_importance (id, referential, encyclopedic, importance) VALUES (?, ?, ?, ?)"
		)

		let encyclopedicCount = 0
		let referentialOnlyCount = 0
		// One row per place in the UNION of the two signals. A place absent from both is absent from
		// the table entirely — the pre-split behavior, and the correct one: a row of zeros would assert
		// that we measured no salience rather than that we measured nothing.
		const allIDs = new Set<number>([...wofReferential.keys(), ...wofEncyclopedic.keys()])

		kdb.exec("BEGIN TRANSACTION")

		for (const wofID of allIDs) {
			const referential = wofReferential.get(wofID) ?? 0
			const encyclopedic = wofEncyclopedic.get(wofID)

			if (encyclopedic === undefined) {
				referentialOnlyCount++
			} else {
				encyclopedicCount++
			}

			// NULL, never 0, for a place with no article — the meaning-of-zero rule at the column level.
			insertStmt.run(wofID, referential, encyclopedic ?? null, blendImportance(referential, encyclopedic))
		}

		kdb.exec("COMMIT")

		// The total is READ BACK, never derived by adding the two counters. The counters describe what
		// this run tried to do; the table is what it did, and when those disagreed nobody noticed
		// because the derived number looked plausible. `SELECT count(*)` cannot drift.
		const total = countRows(kdb, "place_importance")

		await kdb.destroy() // closes the underlying `db` handle

		const elapsed = ((performance.now() - t0) / 1000).toFixed(1)

		return [
			`place_importance: ${dbPath}  (${elapsed}s)`,
			`Encyclopedic (Wikipedia): ${encyclopedicCount} places`,
			`Referential only (no article): ${referentialOnlyCount} places`,
			`Total in place_importance: ${total} places`,
			`Fan-out guard: ${fanout.droppedPlaces} places dropped from ${fanout.unresolvableGroups + fanout.populationGroups} ambiguous Wikidata ids (#1497)`,
		]
	})

	if (state.status !== "done") return <CommandTaskResult state={state} />

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
