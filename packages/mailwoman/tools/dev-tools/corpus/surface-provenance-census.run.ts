/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Reports how many training rows contain a written form the source attested. It also reports how many contain one
 *   a recipe composed from normalized fields.
 *
 *   A normalized source supplies `{street, number, unit, postcode, locality}` and discards the line a
 *   person wrote. A recipe then renders a line from a codex layout. Those rows teach the layout this
 *   repository authored rather than the conventions the jurisdiction attests, so adding more of them
 *   raises row counts and leaves the set of written forms unchanged.
 *
 *   The `surface` column records which form a row contains. The `source` column identifies the adapter.
 *   Together, these columns show whether a locale's street supply teaches attested variety or one template.
 *
 *   Usage:
 *   node packages/mailwoman/tools/dev-tools/corpus/surface-provenance-census.run.ts \
 *     --corpus /mnt/mw/corpus/versioned/v0.7.0-de-holdout/corpus-v0.7.0-de-holdout \
 *     [--split train] [--stride 18] [--country GB] [--json <out>]
 */

import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { escapeSQLString, openDuckDB } from "@mailwoman/corpus/parquet/duckdb"
import { resolvePath } from "path-ts"
import { Globerator } from "spliterator/node/fs"

const { values } = parseArguments({
	options: {
		corpus: { type: "string", description: "Corpus directory holding train/val/test" },
		split: { type: "string", description: "Split to read (default train)" },
		stride: { type: "string", description: "Read every Nth parquet file, to spread across sources (default 18)" },
		country: { type: "string", description: "Restrict to one ISO country code" },
		json: { type: "string", description: "Write the census to this path" },
	},
})

if (!values.corpus) throw new Error("--corpus is required")

const split = values.split ?? "train"
const stride = Number(values.stride ?? 18)

if (!Number.isInteger(stride) || stride < 1)
	throw new Error(`--stride must be a positive integer, read ${values.stride}`)

const splitRoot = resolvePath(values.corpus, split)
const all: string[] = []

for await (const entry of Globerator.from("*.parquet", { cwd: splitRoot, absolute: true })) {
	all.push(entry.toString())
}

if (!all.length) throw new Error(`No parquet file under ${splitRoot}`)

all.sort()

const selected = all.filter((_, index) => index % stride === 0)
const list = selected.map((file) => `'${escapeSQLString(file)}'`).join(", ")
const where = values.country ? ` WHERE country = '${escapeSQLString(values.country.toUpperCase())}'` : ""

console.log(
	`${split}: ${selected.length} of ${all.length} files at stride ${stride}${values.country ? `, country ${values.country.toUpperCase()}` : ""}`
)

using db = await openDuckDB()

const surfaces = (
	await db.runAndReadAll(
		`SELECT surface, count(*) AS rows FROM read_parquet([${list}])${where} GROUP BY 1 ORDER BY rows DESC`
	)
).getRowObjectsJS() as Array<{ surface: string | null; rows: bigint | number }>

const total = surfaces.reduce((sum, row) => sum + Number(row.rows), 0)

if (total === 0) throw new Error(`No row matched under ${splitRoot}${where}`)

console.log(`\nsurface provenance over ${total.toLocaleString()} rows:`)

for (const row of surfaces) {
	const rows = Number(row.rows)

	console.log(
		`  ${String(row.surface ?? "(null)").padEnd(12)} ${rows.toLocaleString().padStart(13)}  ${((rows / total) * 100).toFixed(1)}%`
	)
}

const streetRows = (
	await db.runAndReadAll(
		`SELECT surface, count(*) AS rows FROM read_parquet([${list}])
		 ${where ? `${where} AND` : "WHERE"} list_contains(span_tags, 'street')
		 GROUP BY 1 ORDER BY rows DESC`
	)
).getRowObjectsJS() as Array<{ surface: string | null; rows: bigint | number }>

const streetTotal = streetRows.reduce((sum, row) => sum + Number(row.rows), 0)

console.log(`\nstreet-bearing rows only, ${streetTotal.toLocaleString()} of ${total.toLocaleString()}:`)

for (const row of streetRows) {
	const rows = Number(row.rows)

	console.log(
		`  ${String(row.surface ?? "(null)").padEnd(12)} ${rows.toLocaleString().padStart(13)}  ${((rows / streetTotal) * 100).toFixed(1)}%`
	)
}

const bySource = (
	await db.runAndReadAll(
		`SELECT source, surface, count(*) AS rows FROM read_parquet([${list}])${where}
		 GROUP BY 1,2 ORDER BY rows DESC LIMIT 30`
	)
).getRowObjectsJS() as Array<{ source: string; surface: string | null; rows: bigint | number }>

console.log(`\ntop 30 source × surface:`)

for (const row of bySource) {
	console.log(
		`  ${Number(row.rows).toLocaleString().padStart(12)}  ${String(row.surface ?? "(null)").padEnd(11)} ${row.source}`
	)
}

if (values.json) {
	await writeLocalJSONFile(
		{
			corpus: values.corpus,
			split,
			stride,
			country: values.country?.toUpperCase() ?? null,
			filesRead: selected.length,
			filesAvailable: all.length,
			rows: total,
			surfaces: surfaces.map((row) => ({ surface: row.surface, rows: Number(row.rows) })),
			streetBearing: streetRows.map((row) => ({ surface: row.surface, rows: Number(row.rows) })),
			bySource: bySource.map((row) => ({ source: row.source, surface: row.surface, rows: Number(row.rows) })),
		},
		values.json
	)

	console.log(`\nwrote ${values.json}`)
}
