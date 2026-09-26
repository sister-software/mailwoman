/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman gazetteer importance` — build the `place_importance` table in a WOF SQLite database.
 *   Downloads Nominatim's `wikimedia-importance.csv.gz`, joins it through the `concordances` table, and
 *   writes two scores per place.
 *
 *   The two-score split keeps `referential` (population-anchored, the ranking backbone) and
 *   `encyclopedic` (the Wikipedia join, NULL when there is no article) in their own columns, plus the
 *   legacy `importance` column via `blendImportance`. Schema, DDL, the referential derivation and the
 *   blend live in `@mailwoman/resolver-wof-sqlite/place-importance-schema` — read it before changing
 *   either score.
 *
 *   The table is added to the `--db` in place, and the WOF DB must already carry `concordances` (and,
 *   for the fallback, `place_population`), so run `mailwoman gazetteer build admin` first.
 *
 *   The join is not a function: a Wikidata id can name more than one current WOF place, and
 *   `gazetteer-pipeline/importance-fanout.ts` decides which candidate it means — coincident candidates
 *   are all kept, otherwise decisive population keeps the winner, otherwise the id is dropped. Dropped
 *   places fall through to the population fallback rather than being left blank.
 */

import { cacheRootPath } from "@mailwoman/core/data-root"
import { gunzipChunks } from "@mailwoman/core/fs/compression"
import { tryStat } from "@mailwoman/core/fs/readers"
import { makeDirectories } from "@mailwoman/core/fs/writers"
import { CommandError } from "@mailwoman/core/scripting/command"
import { allRows, streamToDisk } from "@mailwoman/core/utils"
import type { PlaceImportanceDatabase } from "@mailwoman/resolver-wof-sqlite/place-importance-schema"
import { countRows } from "@mailwoman/sqlite/introspection"
import { Box, Text } from "ink"
import { dirname } from "path-ts"
import { createReadStream } from "spliterator/node/fs"

import { type CommandSpec, CommandTaskResult, type CommandComponent, useCommandTask } from "#cli-kit"
import type { FanoutCandidate } from "#gazetteer-pipeline/importance-fanout"

/**
 * Columns a Wikidata concordance row needs before it carries a usable mapping.
 */
const MIN_WIKIDATA_COLUMNS = 5

const IMPORTANCE_READ_HIGH_WATER_MARK = 64 * 1024

const IMPORTANCE_URL = "https://nominatim.org/data/wikimedia-importance.csv.gz"

/**
 * Native command-line interface consumed by the filesystem command router.
 */
export const spec = {
	name: "importance",
	description: "Add place importance to a WOF database",
	options: {
		db: { type: "string", required: true, description: "WOF SQLite database" },
		tsv: { type: "string", description: "Pre-downloaded Wikimedia importance data" },
	},
} as const satisfies CommandSpec

const GazetteerImportance: CommandComponent<typeof spec> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { DatabaseClient } = await import("@mailwoman/sqlite/client")

		const { blendImportance, createPlaceImportanceTable } =
			await import("@mailwoman/resolver-wof-sqlite/place-importance-schema")

		const { referentialFromPopulation } = await import("@mailwoman/core/resolver")

		const { TextSpliterator } = await import("spliterator")

		const { emptyFanoutStats, recordFanout, resolveConcordanceFanout } =
			await import("#gazetteer-pipeline/importance-fanout")

		const dbPath = options.db
		const tsvPath = options.tsv
		const t0 = performance.now()

		if (!(await tryStat(dbPath))) throw new CommandError(`Database not found: ${dbPath}`)

		const kdb = new DatabaseClient<PlaceImportanceDatabase>(dbPath, { open: true })

		// DDL goes through the Kysely schema-builder; the hot insert loop stays on the raw `db` handle.
		console.error("Loading Wikidata concordances from WOF...")

		let concordances: Map<string, number[]>
		const fanout = emptyFanoutStats()

		try {
			// Joins `spr` for the geometry and population the fan-out guard needs, restricts
			// to `is_current = 1` so a dead row cannot win a fan-out group, and is DISTINCT
			// because `concordances` carries duplicate (id, other_id) rows.
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

		console.error("Parsing Wikipedia importance TSV...")

		const importanceMap = new Map<string, number>()
		let totalRows = 0

		const fileChunks = await createReadStream(gzPath, IMPORTANCE_READ_HIGH_WATER_MARK)

		// `crlf: true` because the Wikidata id is the last column, and a CRLF source
		// would leave a stray `\r` on it.
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

		// Each place gets one row carrying both scores in their own columns, and the legacy
		// `importance` column is written by `blendImportance`, the bounded blend whose cap
		// keeps an article-floor score from outranking a population-attested town.
		console.error("Building place_importance table (referential + encyclopedic)...")

		await createPlaceImportanceTable(kdb)

		// A single WOF id can concord to multiple Wikidata ids, and a naive per-Wikidata insert
		// would violate the `id` primary key, so collapse to the max importance per WOF id first.
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
		// so every place with a population carries one whether or not it has an article.
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
		// One row per place in the union of the two signals; a place absent from both is
		// absent from the table entirely, because a row of zeros would assert that we
		// measured no salience rather than that we performed no measurement.
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

		// The total is read back with `select count(*)` rather than derived by adding the two
		// counters, which describe what the run tried to do rather than what the table did.
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
