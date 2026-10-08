/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * CSV → SQLite ingest tool.
 *
 * The tool reads a CSV and samples rows to infer column types.
 * It creates a SQLite table and imports all rows.
 * It handles quoted fields, null-like values and duplicate column names.
 *
 * ## Usage
 *
 *   ```sh
 *   mailwoman corpus ingest-csv \
 *   --input /data/corpus/sources/usgov-nppes/npidata_pfile.csv \
 *   --table nppes_providers \
 *   --output /data/corpus/sources/usgov-nppes/nppes.db
 * ```
 *
 * Options:
 * --input <path> Required CSV path
 * --table <name> Table name (default: from filename)
 * --output <path> DB path (default: input dir/<table>.db)
 * --sample <n> Rows used for type inference (default: 100)
 * --separator <char> Field delimiter (default: ,)
 * --skip <n> Lines to skip before header (default: 0)
 * --no-header Treat CSV as headerless (col_0, col_1, ...)
 * --dry-run Print inferred schema, skip import
 */

import { ByteFormatter } from "@mailwoman/core/fs/formatters"
import { tryStat, pathExists } from "@mailwoman/core/fs/readers/stat"
import { makeDirectories, writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import type { SQLInputValue } from "@mailwoman/sqlite/client"
import type { Database } from "@mailwoman/sqlite/database-schema"
import { basename, dirname, extname, PathBuilder } from "path-ts"
import { CSVSpliterator } from "spliterator"

// #region Column name normalization

/**
 * @deprecated This helper may belong in core.
 * Keep it here until then.
 */
function normalizeColumnName(raw: string): string {
	return (
		raw
			.trim()
			.replaceAll(/^"+|"+$/g, "")
			.toLowerCase()
			.replaceAll(/[^a-z0-9]+/g, "_")
			.replaceAll(/^_|_$/g, "") || "unnamed"
	)
}

function dedupColumns(names: string[]): string[] {
	const seen = new Map<string, number>()

	return names.map((name) => {
		const count = seen.get(name) ?? 0
		seen.set(name, count + 1)

		return count === 0 ? name : `${name}_${count + 1}`
	})
}

// #endregion

// #region Type inference

type SQLiteColType = "INTEGER" | "REAL" | "TEXT"

interface ColumnInfo {
	name: string
	type: SQLiteColType
	nullable: boolean
}

function normalizeField(raw: string): string | null {
	let s = raw.trim()

	if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
		s = s.slice(1, -1).replaceAll('""', '"')
	}

	// Normalize common null-like values
	if (!s || s === "null" || s === "NULL" || s === "N/A" || s === "n/a" || s === "-" || s === "<UNAVAIL>") {
		return null
	}

	return s
}

function inferColumnType(samples: (string | null)[]): ColumnInfo {
	let nullCount = 0
	let intCount = 0
	let realCount = 0
	let textCount = 0

	for (const s of samples) {
		if (!s) {
			nullCount++

			continue
		}

		if (/^-?\d+$/.test(s)) {
			intCount++
		} else if (/^-?\d+\.?\d+$/.test(s)) {
			realCount++
		} else {
			textCount++
		}
	}

	const total = samples.length
	const type: SQLiteColType = realCount / total >= 0.5 ? "REAL" : intCount / total >= 0.5 ? "INTEGER" : "TEXT"

	return { name: "", type, nullable: nullCount / total >= 0.5 }
}

// #endregion

// #region Main: read CSV, infer schema, produce SQL

interface IngestOptions {
	inputPath: string
	tableName: string
	outputPath: string
	sampleSize: number
	separator: string
	skipLines: number
	hasHeader: boolean
	dryRun: boolean
}

async function runIngest(opts: IngestOptions): Promise<void> {
	// Keep parser header handling off so `--skip` works predictably.
	// We read the header row ourselves.
	const rows = (): AsyncIterable<string[]> =>
		CSVSpliterator.fromAsync<string[]>(opts.inputPath, {
			header: false,
			columnDelimiter: opts.separator,
			drop: opts.skipLines,
		})

	// Read header + sample rows to infer schema.
	process.stderr.write(`Reading ${opts.inputPath} for schema inference...\n`)

	let headerRow: string[] | null = null
	const sampleRows: string[][] = []

	for await (const row of rows()) {
		if (!headerRow && opts.hasHeader) {
			headerRow = row

			continue
		}

		if (sampleRows.length < opts.sampleSize) {
			sampleRows.push(row)
		} else {
			break
		}
	}

	if (!headerRow && opts.hasHeader) {
		throw new Error("No header line found in CSV")
	}

	// Normalize and dedupe column names.
	let rawHeaders: string[]

	if (opts.hasHeader && headerRow) {
		rawHeaders = headerRow
	} else {
		// No header: generate col_0, col_1, ...
		const numCols = sampleRows[0]?.length ?? 0
		rawHeaders = Array.from({ length: numCols }, (_, i) => `col_${i}`)
	}

	const colNames = dedupColumns(rawHeaders.map(normalizeColumnName))

	// Infer each column type from samples.
	const columns: ColumnInfo[] = colNames.map((name, i) => {
		const samples = sampleRows.map((row) => {
			const raw = row[i] ?? ""

			return normalizeField(raw)
		})

		const info = inferColumnType(samples)
		info.name = name

		return info
	})

	// Build CREATE TABLE and INSERT SQL.
	const colDefs = columns.map((c) => `"${c.name}" ${c.type}`).join(",\n  ")
	// Raw SQL is intentional: columns and types are dynamic at runtime.
	const createTableSQL = `CREATE TABLE IF NOT EXISTS "${opts.tableName}" (\n  ${colDefs}\n);`

	const tempCols = columns.map((c) => `"${c.name}"`).join(", ")

	process.stderr.write(`\nSchema inferred from ${sampleRows.length} sample rows:\n`)
	process.stderr.write(`${createTableSQL}\n\n`)

	if (opts.dryRun) {
		process.stderr.write("--dry-run: stopping before import\n")

		return
	}

	// Create database and import rows.
	const { DatabaseClient } = await import("@mailwoman/sqlite/client")
	await makeDirectories(dirname(opts.outputPath))

	// Empty schema type is intentional: table shape is runtime-generated.
	using db = new DatabaseClient<Database>(opts.outputPath)
	db.exec("PRAGMA journal_mode = OFF") // faster for bulk import
	db.exec("PRAGMA synchronous = OFF")

	db.exec(createTableSQL)

	// Insert line-by-line in batches (no native .import here).
	process.stderr.write(`Importing rows...\n`)

	const insertStmt = db.prepare(
		`INSERT INTO "${opts.tableName}" (${tempCols}) VALUES (${columns.map(() => "?").join(", ")})`
	)

	let imported = 0
	let headerSkipped = false

	// node:sqlite has no transaction helper.
	// The code uses BEGIN/COMMIT.
	const doInsert = () => {
		db.exec("BEGIN")

		try {
			for (const row of batch) {
				insertStmt.run(...row)
			}

			db.exec("COMMIT")
		} catch (error) {
			db.exec("ROLLBACK")
			throw error
		}
	}

	const batch: SQLInputValue[][] = []
	const BATCH_SIZE = 10_000

	for await (const fields of rows()) {
		if (opts.hasHeader && !headerSkipped) {
			headerSkipped = true

			continue
		}

		const values = fields.map((f, i) => {
			const v = normalizeField(f)

			if (!v) return null
			const col = columns[i]

			if (col?.type === "INTEGER" && /^-?\d+$/.test(v)) return Number.parseInt(v, 10)

			if (col?.type === "REAL" && /^-?\d+\.?\d+$/.test(v)) return Number.parseFloat(v)

			return v
		})

		// Pad or trim to expected column count.
		while (values.length < columns.length) {
			values.push(null)
		}

		values.length = columns.length

		batch.push(values)

		if (batch.length >= BATCH_SIZE) {
			doInsert()
			imported += batch.length
			batch.length = 0

			if (imported % 100_000 === 0) {
				process.stderr.write(`  ${(imported / 1_000_000).toFixed(1)}M rows...\n`)
			}
		}
	}

	// Flush remaining rows.
	if (batch.length) {
		doInsert()
		imported += batch.length
	}

	process.stderr.write(`  Imported ${imported.toLocaleString()} rows into "${opts.tableName}"\n`)

	// Create a simple index on the first text column.
	const firstTextCol = columns.find((c) => c.type === "TEXT")

	if (firstTextCol) {
		process.stderr.write(`Building index on "${firstTextCol.name}"...\n`)

		db.exec(
			`CREATE INDEX IF NOT EXISTS idx_${opts.tableName}_${firstTextCol.name} ON "${opts.tableName}"("${firstTextCol.name}");`
		)
	}

	const stat = await tryStat(opts.outputPath)

	const manifest = {
		ingested_at: new Date().toISOString(),
		source_csv: basename(opts.inputPath),
		table_name: opts.tableName,
		columns: columns.map((c) => ({ name: c.name, type: c.type, nullable: c.nullable })),
		row_count: imported,
		db_bytes: stat!.size,
	}

	const manifestPath = opts.outputPath.replace(/\.db$/, ".manifest.json")
	await writeLocalJSONFile(manifest, manifestPath)

	process.stderr.write(
		`Done. ${imported.toLocaleString()} rows → ${opts.outputPath} (${ByteFormatter.formatIEC(stat!.size)})\n`
	)
}

/**
 * Options for {@linkcode ingestCSV}.
 * `table` and `output` default from `input`.
 */
export interface IngestCSVOptions {
	input: string
	table?: string
	output?: string
	sample?: number
	separator?: string
	skip?: number
	noHeader?: boolean
	dryRun?: boolean
}

/**
 * Ingest a CSV into SQLite: infer column types from a sample, create the table, import the rows.
 *
 * @throws When `input` does not exist.
 */
export async function ingestCSV(options: IngestCSVOptions): Promise<void> {
	if (!(await pathExists(options.input))) {
		throw new Error(`File not found: ${options.input}`)
	}

	const csvName = basename(options.input, extname(options.input))

	await runIngest({
		inputPath: options.input,
		tableName: options.table ?? csvName.replaceAll(/[^a-zA-Z0-9_]/g, "_"),
		outputPath: options.output ?? PathBuilder.from(options.input).dirname()(`${csvName}.db`).toString(),
		sampleSize: options.sample ?? 100,
		separator: options.separator ?? ",",
		skipLines: options.skip ?? 0,
		hasHeader: !options.noHeader,
		dryRun: options.dryRun ?? false,
	})
}

// #endregion
