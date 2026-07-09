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
 */

import { createReadStream, existsSync, writeFileSync } from "node:fs"
import { get as httpsGet } from "node:https"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { createGunzip } from "node:zlib"

import { DatabaseClient } from "@mailwoman/core/kysley/client"
import { Box, Text } from "ink"
import { useEffect, useState } from "react"
import { TextSpliterator } from "spliterator"
import zod from "zod"

import type { CommandComponent } from "../../sdk/cli.ts"

const IMPORTANCE_URL = "https://nominatim.org/data/wikimedia-importance.csv.gz"

const OptionsSchema = zod.object({
	db: zod.string().describe("WOF SQLite DB to add place_importance to (must carry the concordances table)"),
	tsv: zod.string().optional().describe("Pre-downloaded wikimedia-importance.csv.gz. Default: download to $TMPDIR"),
})

export { OptionsSchema as options }

function downloadToFile(url: string, dest: string): Promise<void> {
	return new Promise((resolve, reject) => {
		httpsGet(url, (res) => {
			if (res.statusCode === 301 || res.statusCode === 302) {
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
	const [error, setError] = useState<string>()
	const [summary, setSummary] = useState<string[]>()

	useEffect(() => {
		void (async () => {
			try {
				const dbPath = options.db
				const tsvPath = options.tsv
				const t0 = performance.now()

				if (!existsSync(dbPath)) throw new Error(`Database not found: ${dbPath}`)

				const db = new DatabaseSync(dbPath, { open: true })
				// DDL via the Kysely schema-builder; the hot INSERT loop below stays on the raw `db` handle.
				const kdb = new DatabaseClient({ database: db })

				// Step 1: Load Wikidata concordances from WOF
				console.error("Loading Wikidata concordances from WOF...")
				let concordances: Map<string, number[]>

				try {
					const stmt = db.prepare("SELECT id, other_id FROM concordances WHERE other_source = 'wd:id'")
					const rows = stmt.all() as unknown as Array<{ id: number; other_id: string }>
					concordances = new Map<string, number[]>()

					for (const row of rows) {
						const existing = concordances.get(row.other_id) ?? []
						existing.push(row.id)
						concordances.set(row.other_id, existing)
					}
					console.error(`  ${concordances.size} unique Wikidata IDs from ${rows.length} concordance rows`)
				} catch {
					throw new Error("No concordances table found. Run `mailwoman gazetteer build admin` first.")
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
					const parts = line.split("\t")

					if (parts.length < 5) continue

					const importance = Number(parts[3]!)
					const wikidataID = parts[4]!

					if (!wikidataID || !concordances.has(wikidataID)) continue

					if (isNaN(importance)) continue

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

				db.exec("BEGIN TRANSACTION")

				for (const [wikidataID, importance] of importanceMap) {
					const wofIDs = concordances.get(wikidataID)

					if (!wofIDs) continue

					for (const wofID of wofIDs) {
						insertStmt.run(wofID, importance)
						importanceCount++
					}
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
							const pseudoImportance = Math.min(1.0, Math.log2(1 + row.population / 1000) / 14)
							fallbackInsert.run(row.id, pseudoImportance)
							fallbackCount++
						}
					}
					db.exec("COMMIT")
				} catch {
					console.error("  No place_population table — skipping fallback")
				}

				await kdb.destroy() // closes the underlying `db` handle

				const elapsed = ((performance.now() - t0) / 1000).toFixed(1)
				setSummary([
					`place_importance: ${dbPath}  (${elapsed}s)`,
					`Wikipedia importance: ${importanceCount} places`,
					`Population fallback:  ${fallbackCount} places`,
					`Total in place_importance: ${importanceCount + fallbackCount} places`,
				])
			} catch (e) {
				setError(e instanceof Error ? e.message : String(e))
			}
		})()
	}, [options])

	useEffect(() => {
		if (summary || error) {
			setImmediate(() => process.exit(error ? 1 : 0))
		}
	}, [summary, error])

	if (error) return <Text color="red">✗ {error}</Text>

	if (summary) {
		return (
			<Box flexDirection="column">
				{summary.map((line, i) => (
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
