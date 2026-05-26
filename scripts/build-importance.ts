/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build the `place_importance` table in a WOF SQLite database from Nominatim's Wikipedia importance
 *   data. Downloads wikimedia-importance.csv.gz, joins through the concordances table, and writes
 *   importance scores for each WOF place with a Wikidata mapping.
 *
 *   Usage: npx tsx scripts/build-importance.ts --db /path/to/wof.db npx tsx
 *   scripts/build-importance.ts --db /path/to/wof.db --tsv /path/to/wikimedia-importance.csv.gz
 */

import { createReadStream, existsSync, writeFileSync } from "node:fs"
import { get as httpsGet } from "node:https"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { DatabaseSync } from "node:sqlite"
import { Writable } from "node:stream"
import { createGunzip } from "node:zlib"

const IMPORTANCE_URL = "https://nominatim.org/data/wikimedia-importance.csv.gz"

interface Args {
	dbPath: string
	tsvPath?: string
}

function parseArgs(): Args {
	const args = process.argv.slice(2)
	let dbPath: string | undefined
	let tsvPath: string | undefined

	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--db" && args[i + 1]) {
			dbPath = args[++i]
		} else if (args[i] === "--tsv" && args[i + 1]) {
			tsvPath = args[++i]
		}
	}

	if (!dbPath) {
		console.error("Usage: npx tsx scripts/build-importance.ts --db <wof.db> [--tsv <wikimedia-importance.csv.gz>]")
		process.exit(1)
	}

	return { dbPath, tsvPath }
}

function downloadToFile(url: string, dest: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const file = Writable.toWeb(
			new (class extends Writable {
				private chunks: Buffer[] = []
				_write(chunk: Buffer, _enc: string, cb: () => void) {
					this.chunks.push(chunk)
					cb()
				}
				_final(cb: () => void) {
					writeFileSync(dest, Buffer.concat(this.chunks))
					cb()
				}
			})()
		)

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

async function main() {
	const { dbPath, tsvPath } = parseArgs()
	const t0 = performance.now()

	if (!existsSync(dbPath)) {
		console.error(`Database not found: ${dbPath}`)
		process.exit(1)
	}

	const db = new DatabaseSync(dbPath, { open: true })

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
	} catch (error) {
		console.error("No concordances table found. Run wof/prepare first.")
		process.exit(1)
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
	const rl = createInterface({ input: fileStream.pipe(gunzip) })

	for await (const line of rl) {
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
	db.exec("DROP TABLE IF EXISTS place_importance")
	db.exec("CREATE TABLE place_importance (id INTEGER PRIMARY KEY, importance REAL NOT NULL)")

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

	db.close()

	const elapsed = ((performance.now() - t0) / 1000).toFixed(1)
	console.error(`\nDone in ${elapsed}s:`)
	console.error(`  Wikipedia importance: ${importanceCount} places`)
	console.error(`  Population fallback:  ${fallbackCount} places`)
	console.error(`  Total in place_importance: ${importanceCount + fallbackCount} places`)
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
