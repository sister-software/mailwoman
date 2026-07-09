/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   CSV → SQLite ingestion utility. Ported from isp-nexus's `sdk/data/csv.ts`.
 *
 *   Reads a CSV file, infers column types from a sample of rows, creates a SQLite table, and imports
 *   the data. Handles quoted fields, NULL normalization, and duplicate column name disambiguation.
 *
 *   ## Usage
 *
 *   ```sh
 *   mailwoman corpus ingest-csv \
 *   --input /data/corpus/sources/usgov-nppes/npidata_pfile.csv \
 *   --table nppes_providers \
 *   --output /data/corpus/sources/usgov-nppes/nppes.db
 * ```
 *
 *   Options: --input <path> CSV file to ingest (required) --table <name> SQLite table name (default:
 *   derived from input filename) --output <path> SQLite database path (default: input dir /
 *   table.db) --sample <n> Rows to sample for type inference (default: 100) --separator <char>
 *   Field separator (default: ,) --skip <n> Lines to skip before header (default: 0) --no-header
 *   CSV has no header row — columns will be col_0, col_1, etc. --dry-run Infer schema and print
 *   CREATE TABLE, but don't import
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { basename, dirname, extname, join } from "node:path"
import type { SQLInputValue } from "node:sqlite"

import { TextSpliterator } from "spliterator"

// ---------------------------------------------------------------------------
// Core: quote-aware CSV field splitting
// ---------------------------------------------------------------------------

const COMMA = 44
const DOUBLE_QUOTE = 34

// These stay hand-rolled on purpose — spliterator ≥ 3.2.0's CSVSpliterator does quote handling
// correctly now, but it can't express this tool's CLI contract: `--skip N` drops N preamble lines
// BEFORE the header (CSVSpliterator consumes row 1 as the header immediately, with no skip-first-N
// hook), `--no-header` auto-generates `col_0…col_N` names from the first data row's width, and the
// separator is any single caller-supplied byte. If a future edit removes those knobs, revisit;
// until then, don't "finish the job" by swapping in CSVSpliterator.
function splitCSVLine(line: string, separator: number = COMMA): string[] {
	const fields: string[] = []
	let start = 0
	let inQuotes = false

	for (let i = 0; i < line.length; i++) {
		const ch = line.charCodeAt(i)

		if (ch === DOUBLE_QUOTE) {
			inQuotes = !inQuotes
		} else if (ch === separator && !inQuotes) {
			fields.push(line.slice(start, i))
			start = i + 1
		}
	}
	fields.push(line.slice(start))

	return fields
}

function stripQuotes(field: string): string {
	const trimmed = field.trim()

	if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
		return trimmed.slice(1, -1).replace(/""/g, '"')
	}

	return trimmed
}

// ---------------------------------------------------------------------------
// Column name normalization
// ---------------------------------------------------------------------------

function normalizeColumnName(raw: string): string {
	return (
		raw
			.trim()
			.replace(/^"+|"+$/g, "")
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "_")
			.replace(/^_|_$/g, "") || "unnamed"
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

// ---------------------------------------------------------------------------
// Type inference
// ---------------------------------------------------------------------------

type SQLiteColType = "INTEGER" | "REAL" | "TEXT"

interface ColumnInfo {
	name: string
	type: SQLiteColType
	nullable: boolean
}

function normalizeField(raw: string): string | null {
	let s = raw.trim()

	if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
		s = s.slice(1, -1).replace(/""/g, '"')
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
		if (s === null) {
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

// ---------------------------------------------------------------------------
// Main: read CSV, infer schema, produce SQL
// ---------------------------------------------------------------------------

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
	const sep = opts.separator.charCodeAt(0)

	// --- Pass 1: read header + sample rows for type inference ---
	process.stderr.write(`Reading ${opts.inputPath} for schema inference...\n`)

	// CRLF-safe by construction: every field below flows through stripQuotes/normalizeField, both of
	// which `.trim()`, so a trailing CR on the last column of a CRLF file is stripped. TextSpliterator's
	// default skipEmpty matches readline row-for-row on files with a trailing newline (the common case);
	// it drops interior blank lines that readline would have turned into all-null rows. The early `break`
	// closes the file descriptor.
	let headerLine: string | null = null
	const sampleRows: string[][] = []
	let lineNum = 0

	for await (const line of TextSpliterator.fromAsync(opts.inputPath)) {
		lineNum++

		// Skip lines before header
		if (lineNum <= opts.skipLines) continue

		if (!headerLine && opts.hasHeader) {
			headerLine = line
			continue
		}

		if (sampleRows.length < opts.sampleSize) {
			sampleRows.push(splitCSVLine(line, sep).map(stripQuotes))
		} else {
			break
		}
	}

	if (!headerLine && opts.hasHeader) {
		throw new Error("No header line found in CSV")
	}

	// --- Determine column names ---
	let rawHeaders: string[]

	if (opts.hasHeader && headerLine) {
		rawHeaders = splitCSVLine(headerLine, sep).map(stripQuotes)
	} else {
		// Auto-generate column names: col_0, col_1, ...
		const numCols = sampleRows[0]?.length ?? 0
		rawHeaders = Array.from({ length: numCols }, (_, i) => `col_${i}`)
	}

	const colNames = dedupColumns(rawHeaders.map(normalizeColumnName))

	// --- Infer column types ---
	const columns: ColumnInfo[] = colNames.map((name, i) => {
		const samples = sampleRows.map((row) => {
			const raw = row[i] ?? ""

			return normalizeField(raw)
		})
		const info = inferColumnType(samples)
		info.name = name

		return info
	})

	// --- Generate SQL ---
	const colDefs = columns.map((c) => `"${c.name}" ${c.type}`).join(",\n  ")
	// Raw DDL by design: the column set + types are INFERRED from the CSV at runtime (colDefs above),
	// so a Kysely builder loop would just wrap the same dynamic strings with ceremony and no type safety.
	const createTableSQL = `CREATE TABLE IF NOT EXISTS "${opts.tableName}" (\n  ${colDefs}\n);`

	const tempCols = columns.map((c) => `"${c.name}"`).join(", ")
	const insertSQL = `INSERT INTO "${opts.tableName}" (${tempCols})\nSELECT ${tempCols} FROM temp."${opts.tableName}_source";`

	process.stderr.write(`\nSchema inferred from ${sampleRows.length} sample rows:\n`)
	process.stderr.write(`${createTableSQL}\n\n`)

	if (opts.dryRun) {
		process.stderr.write("--dry-run: stopping before import\n")

		return
	}

	// --- Create database + import ---
	const { DatabaseSync } = await import("node:sqlite")
	mkdirSync(dirname(opts.outputPath), { recursive: true })

	const db = new DatabaseSync(opts.outputPath)
	db.exec("PRAGMA journal_mode = OFF") // faster for bulk import
	db.exec("PRAGMA synchronous = OFF")

	db.exec(createTableSQL)

	// Use the .import approach via a temp table, then INSERT INTO ... SELECT to handle
	// NULL normalization and type coercion.
	const csvBasename = basename(opts.inputPath)
	const importSQL = [
		`CREATE TEMP TABLE "${opts.tableName}_source" (${colDefs});`,
		`.mode csv`,
		`.separator "${opts.separator}"`,
		`.import "${csvBasename}" --skip ${opts.skipLines + (opts.hasHeader ? 1 : 0)} --schema temp ${opts.tableName}_source`,
		insertSQL,
		`DROP TABLE temp."${opts.tableName}_source";`,
	]

	// better-sqlite3 doesn't support .import natively, so we use a different approach:
	// Read the CSV line-by-line and INSERT in a transaction.
	process.stderr.write(`Importing rows...\n`)

	const insertStmt = db.prepare(
		`INSERT INTO "${opts.tableName}" (${tempCols}) VALUES (${columns.map(() => "?").join(", ")})`
	)

	let imported = 0
	let headerSkipped = false

	// node:sqlite has no `db.transaction(fn)` wrapper; use raw BEGIN/COMMIT around the batch.
	const doInsert = () => {
		db.exec("BEGIN")

		try {
			for (const row of batch) {
				insertStmt.run(...row)
			}
			db.exec("COMMIT")
		} catch (err) {
			db.exec("ROLLBACK")
			throw err
		}
	}

	const batch: SQLInputValue[][] = []
	const BATCH_SIZE = 10000

	for await (const line of TextSpliterator.fromAsync(opts.inputPath)) {
		lineNum++

		if (lineNum <= opts.skipLines) continue

		if (opts.hasHeader && !headerSkipped) {
			headerSkipped = true
			continue
		}

		const fields = splitCSVLine(line, sep).map(stripQuotes)
		const values = fields.map((f, i) => {
			const v = normalizeField(f)

			if (v === null) return null
			const col = columns[i]

			if (col?.type === "INTEGER" && /^-?\d+$/.test(v)) return parseInt(v, 10)

			if (col?.type === "REAL" && /^-?\d+\.?\d+$/.test(v)) return parseFloat(v)

			return v
		})

		// Pad or truncate to column count
		while (values.length < columns.length) {
			values.push(null)
		}
		values.length = columns.length

		batch.push(values)

		if (batch.length >= BATCH_SIZE) {
			doInsert()
			imported += batch.length
			batch.length = 0

			if (imported % 100000 === 0) {
				process.stderr.write(`  ${(imported / 1_000_000).toFixed(1)}M rows...\n`)
			}
		}
	}

	// Flush remaining
	if (batch.length > 0) {
		doInsert()
		imported += batch.length
	}

	process.stderr.write(`  Imported ${imported.toLocaleString()} rows into "${opts.tableName}"\n`)

	// Build a basic index on the first TEXT column (likely the primary key)
	const firstTextCol = columns.find((c) => c.type === "TEXT")

	if (firstTextCol) {
		process.stderr.write(`Building index on "${firstTextCol.name}"...\n`)
		db.exec(
			`CREATE INDEX IF NOT EXISTS idx_${opts.tableName}_${firstTextCol.name} ON "${opts.tableName}"("${firstTextCol.name}");`
		)
	}

	db.close()

	// Write MANIFEST
	const fileSize = (await import("node:fs/promises")).stat
	const stat = await (await import("node:fs/promises")).stat(opts.outputPath)
	const manifest = {
		ingested_at: new Date().toISOString(),
		source_csv: basename(opts.inputPath),
		table_name: opts.tableName,
		columns: columns.map((c) => ({ name: c.name, type: c.type, nullable: c.nullable })),
		row_count: imported,
		db_bytes: stat.size,
	}
	const manifestPath = opts.outputPath.replace(/\.db$/, ".manifest.json")
	writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n")

	process.stderr.write(
		`Done. ${imported.toLocaleString()} rows → ${opts.outputPath} (${(stat.size / 1024 / 1024).toFixed(0)} MB)\n`
	)
}

/** Flag-shaped options for {@linkcode ingestCSV} — `table`/`output` derive from `input` when omitted. */
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
 * Ingest a CSV into SQLite: infer column types from a sample, create the table, import the rows. Throws when `input` is
 * missing. NOTE(phase1): progress narration still writes stderr directly — this predates the report-callback contract
 * and the write sites are deep in the type-inference helpers; thread a report param if a caller ever needs to capture
 * it.
 */
export async function ingestCSV(options: IngestCSVOptions): Promise<void> {
	if (!existsSync(options.input)) {
		throw new Error(`File not found: ${options.input}`)
	}
	const csvName = basename(options.input, extname(options.input))

	await runIngest({
		inputPath: options.input,
		tableName: options.table ?? csvName.replace(/[^a-zA-Z0-9_]/g, "_"),
		outputPath: options.output ?? join(dirname(options.input), csvName + ".db"),
		sampleSize: options.sample ?? 100,
		separator: options.separator ?? ",",
		skipLines: options.skip ?? 0,
		hasHeader: !options.noHeader,
		dryRun: options.dryRun ?? false,
	})
}
