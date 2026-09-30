/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Reports the token patterns a corpus labels differently depending on the address system the row
 *   came from. It also reports the share of each country's rows in each shape.
 *
 *   A shape is the sequence of token character classes — `alpha alpha digit punct alpha punct digit`
 *   for `Main Street 12, Springfield, 62701`. A labeling is the tag sequence the corpus assigns those
 *   same tokens. One shape with two labelings across two countries is a pattern a single decoder
 *   has to resolve from context. A row whose context does not settle it is a row the decoder can
 *   only get right for one of the two systems.
 *
 *   This measures that conflict rather than corpus volume. When rows are added to a country, the
 *   dominant labeling can change. The shape remains conflicted.
 *
 *   A sample can estimate the reported rate over shapes. A sample cannot estimate a distinct count.
 *   This report contains no distinct count.
 *
 *   Usage:
 *   node packages/mailwoman/tools/dev-tools/corpus/grammar-conflict-census.run.ts \
 *     --corpus /mnt/mw/corpus/versioned/v0.7.0-de-holdout/corpus-v0.7.0-de-holdout \
 *     [--split train] [--files 40] [--rows-per-file 20000] [--min-country-rows 500] [--json <out>]
 */

import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { escapeSQLString, openDuckDB } from "@mailwoman/corpus/parquet/duckdb"
import { classifyToken } from "@mailwoman/query-shape/character-class"
import { resolvePath } from "path-ts"
import { Globerator } from "spliterator/node/fs"

const { values } = parseArguments({
	options: {
		corpus: { type: "string", description: "Corpus directory holding train/val/test" },
		split: { type: "string", description: "Split to read (default train)" },
		files: { type: "string", description: "How many parquet files to read (default 40)" },
		"rows-per-file": { type: "string", description: "Rows to read from each file (default 20000)" },
		"min-country-rows": {
			type: "string",
			description: "A country needs this many rows in a shape before its labeling counts (default 500)",
		},
		json: { type: "string", description: "Write the conflicted shapes to this path" },
	},
})

if (!values.corpus) throw new Error("--corpus is required")

const split = values.split ?? "train"
const fileLimit = Number(values.files ?? 40)
const rowsPerFile = Number(values["rows-per-file"] ?? 20_000)
const minCountryRows = Number(values["min-country-rows"] ?? 500)

for (const [name, value] of [
	["--files", fileLimit],
	["--rows-per-file", rowsPerFile],
	["--min-country-rows", minCountryRows],
] as const) {
	if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number, read ${value}`)
}

const splitRoot = resolvePath(values.corpus, split)
const files: string[] = []

for await (const entry of Globerator.from("*.parquet", { cwd: splitRoot, absolute: true })) {
	files.push(entry.toString())
}

if (!files.length) throw new Error(`No parquet file under ${splitRoot}`)

files.sort()

const selected = files.slice(0, fileLimit)

console.log(`${split}: reading ${selected.length} of ${files.length} files, ${rowsPerFile.toLocaleString()} rows each`)

/**
 * Collapse `B-street` and `I-street` to `street`, because the conflict is about the tag.
 */
const tagOf = (label: string): string => (label.startsWith("B-") || label.startsWith("I-") ? label.slice(2) : label)

/**
 * shape → country → labeling → rows
 */
const shapes = new Map<string, Map<string, Map<string, number>>>()
const rowsByCountry = new Map<string, number>()
let rowsRead = 0
let rowsSkipped = 0

using db = await openDuckDB()

for (const [index, file] of selected.entries()) {
	const result = await db.runAndReadAll(
		`SELECT tokens, labels, country FROM read_parquet('${escapeSQLString(file)}') LIMIT ${rowsPerFile}`
	)

	for (const row of result.getRowObjectsJS() as Array<{
		tokens: string[] | null
		labels: string[] | null
		country: string | null
	}>) {
		const { tokens, labels, country } = row

		// A row missing any of the three cannot be attributed to a system or a shape.
		// Counted and reported rather than dropped, so the denominator stays visible.
		if (!tokens || !labels || !country || !tokens.length || tokens.length !== labels.length) {
			rowsSkipped++

			continue
		}

		const shape = tokens.map((token) => classifyToken(token)).join(" ")
		const labeling = labels.map((label) => tagOf(label)).join(" ")

		const byCountry = shapes.get(shape) ?? new Map<string, Map<string, number>>()
		const byLabeling = byCountry.get(country) ?? new Map<string, number>()

		byLabeling.set(labeling, (byLabeling.get(labeling) ?? 0) + 1)
		byCountry.set(country, byLabeling)
		shapes.set(shape, byCountry)
		rowsByCountry.set(country, (rowsByCountry.get(country) ?? 0) + 1)

		rowsRead++
	}

	if ((index + 1) % 10 === 0) {
		console.log(`  ${index + 1}/${selected.length} files, ${rowsRead.toLocaleString()} rows`)
	}
}

console.log(`read ${rowsRead.toLocaleString()} rows across ${rowsByCountry.size} countries, skipped ${rowsSkipped}`)

const modal = (byLabeling: Map<string, number>): { labeling: string; rows: number } => {
	let best = { labeling: "", rows: -1 }

	for (const [labeling, rows] of byLabeling) {
		if (rows > best.rows) {
			best = { labeling, rows }
		}
	}

	return best
}

interface ConflictedShape {
	shape: string
	tokens: number
	rows: number
	countries: Array<{ country: string; rows: number; labeling: string }>
}

const conflicted: ConflictedShape[] = []
const conflictedRowsByCountry = new Map<string, number>()

for (const [shape, byCountry] of shapes) {
	const attested = [...byCountry]
		.map(([country, byLabeling]) => ({ country, ...modal(byLabeling) }))
		.filter((entry) => entry.rows >= minCountryRows)

	if (attested.length < 2) continue

	const labelings = new Set(attested.map((entry) => entry.labeling))

	if (labelings.size < 2) continue

	const rows = attested.reduce((total, entry) => total + entry.rows, 0)

	conflicted.push({
		shape,
		tokens: shape.split(" ").length,
		rows,
		countries: attested.toSorted((a, b) => b.rows - a.rows),
	})

	for (const entry of attested) {
		conflictedRowsByCountry.set(entry.country, (conflictedRowsByCountry.get(entry.country) ?? 0) + entry.rows)
	}
}

conflicted.sort((a, b) => b.rows - a.rows)

console.log(
	`\n${conflicted.length} shapes carry two or more labelings across countries, each attested by ${minCountryRows}+ rows`
)

for (const entry of conflicted.slice(0, 12)) {
	console.log(`\n  shape: ${entry.shape}   (${entry.rows.toLocaleString()} rows)`)

	for (const country of entry.countries.slice(0, 5)) {
		console.log(`    ${country.country}  ${country.rows.toLocaleString()} rows  ->  ${country.labeling}`)
	}
}

console.log(`\nshare of each country's sampled rows sitting in a conflicted shape:`)

const shares = [...rowsByCountry]
	.map(([country, rows]) => ({
		country,
		rows,
		conflicted: conflictedRowsByCountry.get(country) ?? 0,
		share: rows > 0 ? ((conflictedRowsByCountry.get(country) ?? 0) / rows) * 100 : 0,
	}))
	.filter((entry) => entry.rows >= minCountryRows)
	.toSorted((a, b) => b.share - a.share)

for (const entry of shares) {
	console.log(
		`  ${entry.country}  ${entry.share.toFixed(1)}%  (${entry.conflicted.toLocaleString()} of ${entry.rows.toLocaleString()})`
	)
}

if (values.json) {
	await writeLocalJSONFile(
		{
			corpus: values.corpus,
			split,
			filesRead: selected.length,
			filesAvailable: files.length,
			rowsPerFile,
			minCountryRows,
			rowsRead,
			rowsSkipped,
			conflictedShapes: conflicted,
			shares,
		},
		values.json
	)

	console.log(`\nwrote ${values.json}`)
}
