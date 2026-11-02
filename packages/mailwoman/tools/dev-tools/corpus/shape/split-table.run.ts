/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Writes the country–shape split table of a built corpus: for every country and ordered shape, its share of the
 *   country's eligible addresses, its independent training and held-out groups, its actual held-out share beside the
 *   country's split policy, and whether the retention floor holds (HOLDOUT_AND_EVALUATION section 5.1, #2893).
 *
 *   An eligible address is a base row (no `base_source_id`). An independent group is a record,
 *   `coalesce(base_source_id, record id of source_id)`, as `retention.run.ts` counts it. A row's split is the one
 *   its file's split attribute records. Every combination is a row of the table, including one with no training group.
 *   Usage:
 *     node packages/mailwoman/tools/dev-tools/corpus/shape/split-table.run.ts --manifest <MANIFEST.json> \
 *       --retention <SPLIT_RETENTION.json> --floor 10 --json <table.json> --markdown <table.md> [--memory-gb 12]
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { openWriteStream } from "@mailwoman/core/fs/streams"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalJSONFile, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/json"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { formatPercent } from "@mailwoman/core/stats"
import { recordIDSQL } from "@mailwoman/corpus/adapters/record-id"
import { escapeSQLString, openDuckDB } from "@mailwoman/corpus/parquet/duckdb"
import { localManifestFilePath } from "@mailwoman/corpus/tools/overlay/manifest"
import { defaultHoldouts, HASHED_PLACE_HOLDOUT_SHARE } from "@mailwoman/corpus/utils/split"

const { values: args } = parseArguments({
	options: {
		manifest: { type: "string" },
		retention: { type: "string" },
		floor: { type: "string", default: "10" },
		json: { type: "string" },
		markdown: { type: "string" },
		"memory-gb": { type: "string" },
		"temp-dir": { type: "string" },
	},
})

if (!args.manifest || !args.json || !args.markdown) {
	throw new Error("shape-split-table: --manifest, --json and --markdown are required")
}

const floor = Number(args.floor)

const manifest = await readLocalJSONFile<{
	corpus_version: string
	files: Array<{ path: string; split_attribute?: { path: string } }>
}>(args.manifest)

const retained = new Set(
	args.retention ? (await readLocalJSONFile<{ protectedShapes: string[] }>(args.retention)).protectedShapes : []
)

await using scratch = await temporaryDirectory("shape-split-table-")
const splitsJSONL = scratch.path("splits.jsonl").toString()

{
	const out = openWriteStream(splitsJSONL, { encoding: "utf8" })

	for (const file of manifest.files) {
		if (!file.split_attribute) throw new Error(`manifest file ${file.path} records no split attribute`)

		const attribute = await readLocalJSONFile<{ val: string[]; test: string[] }>(
			localManifestFilePath(file.split_attribute.path)
		)

		for (const id of attribute.val) {
			out.write(stringifyJSON({ source_id: id, split: "val" }) + "\n")
		}

		for (const id of attribute.test) {
			out.write(stringifyJSON({ source_id: id, split: "test" }) + "\n")
		}
	}

	await new Promise<void>((resolve, reject) => {
		out.end((error: Error | null) => (error ? reject(error) : resolve()))
	})
}

// The distinct-group count over every row spills tens of gigabytes; `--temp-dir` puts the spill on a volume with room.
using db = await openDuckDB({
	threads: 4,
	...(args["memory-gb"] ? { memoryLimitBytes: Number(args["memory-gb"]) * 1024 ** 3 } : {}),
	...(args["temp-dir"] ? { temporaryDirectory: args["temp-dir"] } : {}),
})

await db.run(
	`CREATE TEMP TABLE splits AS SELECT DISTINCT source_id, split FROM read_json('${escapeSQLString(splitsJSONL)}', format='newline_delimited')`
)

const paths = manifest.files.map((file) => `'${escapeSQLString(localManifestFilePath(file.path))}'`).join(", ")
const group = `hash(coalesce(nullif(p.base_source_id, ''), ${recordIDSQL("p.source_id")}))`

// A grouped `count(DISTINCT …)` over every row holds its sets in memory and ran out of it.
// The first stage writes each distinct (country, shape, held-out, group) with
// its base-row counts to a table.
// DuckDB can spill that table to disk.
// The second stage counts its rows.
await db.run(`
	CREATE TEMP TABLE groups AS
	SELECT p.country AS country, array_to_string(p.span_tags, ' -> ') AS shape,
		coalesce(s.split, 'train') <> 'train' AS held, ${group} AS g,
		count(*) FILTER (WHERE coalesce(p.base_source_id, '') = '')::BIGINT AS base_rows
	FROM read_parquet([${paths}], union_by_name = true) p
	LEFT JOIN splits s ON s.source_id = p.source_id
	GROUP BY ALL`)

const rows = (
	await db.runAndReadAll(`
		SELECT country, shape,
			sum(base_rows)::BIGINT AS base_rows,
			sum(base_rows) FILTER (WHERE held)::BIGINT AS held_rows,
			count(*) FILTER (WHERE NOT held)::BIGINT AS train_groups,
			count(*) FILTER (WHERE held)::BIGINT AS held_groups
		FROM groups GROUP BY ALL`)
).getRowObjectsJson() as Array<Record<string, unknown>>

const holdouts = defaultHoldouts()
const countryBase = new Map<string, number>()

for (const row of rows) {
	countryBase.set(String(row.country), (countryBase.get(String(row.country)) ?? 0) + Number(row.base_rows))
}

const policyOf = (country: string) =>
	holdouts[country] ? "declared places" : `hashed places, ${(HASHED_PLACE_HOLDOUT_SHARE * 100).toFixed(0)}% of places`

const table = rows
	.map((row) => {
		const country = String(row.country)
		const shape = String(row.shape)
		const key = `${country}|${shape}`
		const baseRows = Number(row.base_rows)
		const trainGroups = Number(row.train_groups)
		const heldGroups = Number(row.held_groups)
		const groups = trainGroups + heldGroups

		const status =
			trainGroups === 0
				? "no training group"
				: trainGroups < floor
					? retained.has(key)
						? "below floor, retained"
						: "below floor, not retained"
					: heldGroups === 0
						? "never held out"
						: "ok"

		return {
			country,
			shape,
			shareOfCountry: (countryBase.get(country) ?? 0) > 0 ? baseRows / countryBase.get(country)! : 0,
			baseRows,
			trainGroups,
			heldGroups,
			heldGroupShare: groups > 0 ? heldGroups / groups : 0,
			heldRowShare: baseRows > 0 ? Number(row.held_rows) / baseRows : 0,
			policy: policyOf(country),
			retained: retained.has(key),
			status,
		}
	})
	.toSorted((a, b) => a.country.localeCompare(b.country) || b.shareOfCountry - a.shareOfCountry)

const statusCounts: Record<string, number> = {}

for (const row of table) {
	statusCounts[row.status] = (statusCounts[row.status] ?? 0) + 1
}

await writeLocalJSONFile(
	{ schema: "mailwoman.shape-split-table/v1", corpus: manifest.corpus_version, floor, statusCounts, table },
	args.json
)

const pct = (share: number) => formatPercent(share, 2)

let markdown =
	`# Country–shape split table — corpus ${manifest.corpus_version}\n\n` +
	`Floor ${floor} independent training groups. Combinations by status: ` +
	Object.entries(statusCounts)
		.map(([status, n]) => `${status} ${n}`)
		.join(", ") +
	".\n\n| Country | Shape | Share of country | Base rows | Train groups | Held-out groups | Held-out share (groups) | Held-out share (rows) | Policy | Status |\n" +
	"| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |\n"

for (const row of table) {
	markdown +=
		`| ${row.country} | \`${row.shape || "(no spans)"}\` | ${pct(row.shareOfCountry)} | ${row.baseRows} | ` +
		`${row.trainGroups} | ${row.heldGroups} | ${pct(row.heldGroupShare)} | ${pct(row.heldRowShare)} | ${row.policy} | ${row.status} |\n`
}

await writeLocalTextFile(markdown, args.markdown)

console.log(stringifyJSON(statusCounts))
