// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file Counts, for every country, a corpus's base rows with a region and those that write a second-level
 *   (WOF `county`) name in the region slot, and writes the counts to the table the `region:unknown` rule reads.
 *
 *   Usage:
 *     node packages/corpus/lib/tools/region-slot-census.run.ts --manifest <MANIFEST.json> \
 *       --out <census.json> [--table packages/corpus/data/region-slot-second-level.json]
 *
 *   A row counts as `secondLevelOnly` when its region is no region name of its country and is a county
 *   name of it. `--out` also lists each country's leading sources and values.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { parseArguments, requiredArgument } from "@mailwoman/core/scripting/arguments"
import { wofDatabasePath } from "@mailwoman/resolver-wof-sqlite/paths"

import {
	readRegionNames,
	readSecondLevelNames,
	secondLevelAdmitted,
	type SecondLevelRegionTable,
} from "#build/region/names"
import { escapeSQLString, openDuckDB } from "#parquet/duckdb"
import { parquetColumnNames } from "#parquet/readers"
import { localManifestFilePath } from "#tools/overlay/manifest"

const { values } = parseArguments({
	options: {
		manifest: { type: "string" },
		out: { type: "string" },
		table: { type: "string" },
	},
})

const command = "region-slot-census"
const manifestPath = requiredArgument(command, "--manifest", values.manifest)
const outPath = requiredArgument(command, "--out", values.out)

const REQUIRED_COLUMNS = ["raw", "country", "source", "span_starts", "span_ends", "span_tags"] as const
const TOP_VALUES = 15

interface CountryTally {
	withRegion: number
	region: number
	secondLevelOnly: number
	neither: number
	secondLevelOnlyBySource: Map<string, number>
	secondLevelOnlyValues: Map<string, number>
}

const database = wofDatabasePath("admin-global-priority.db")
const regions = await readRegionNames(database)
const secondLevel = await readSecondLevelNames(database)
const manifest = await readLocalJSONFile<{ files: { path: string }[] }>(manifestPath)
const tallies = new Map<string, CountryTally>()
const unread: string[] = []
const started = Date.now()
let baseRows = 0

const increment = (map: Map<string, number>, key: string) => map.set(key, (map.get(key) ?? 0) + 1)

using db = await openDuckDB({ memoryLimitBytes: 2 * 1024 ** 3 })

for (const [index, file] of manifest.files.entries()) {
	const path = localManifestFilePath(file.path)
	const columns = new Set(await parquetColumnNames(path))

	if (!REQUIRED_COLUMNS.every((column) => columns.has(column))) {
		unread.push(path)

		continue
	}

	const baseColumn = ["base_source_id", "synth_base_id"].find((column) => columns.has(column))

	const stream = await db.stream(
		`SELECT ${REQUIRED_COLUMNS.join(", ")} FROM read_parquet('${escapeSQLString(path)}')` +
			(baseColumn ? ` WHERE coalesce(${baseColumn}, '') = ''` : "")
	)

	const names = stream.columnNames()

	for (let chunk = await stream.fetchChunk(); chunk && chunk.rowCount > 0; chunk = await stream.fetchChunk()) {
		for (const row of chunk.getRowObjects(names)) {
			baseRows++

			// DuckDB returns a LIST column as `{ items }`; the span offsets index `raw`'s UTF-16 code units.
			const at = (row.span_tags as { items: readonly string[] }).items.indexOf("region")

			if (at === -1) continue

			const raw = String(row.raw)
			const start = (row.span_starts as { items: readonly (number | bigint)[] }).items[at]
			const end = (row.span_ends as { items: readonly (number | bigint)[] }).items[at]
			const value = start != null && end != null ? raw.slice(Number(start), Number(end)) : ""
			const country = String(row.country ?? "").toUpperCase()

			if (!value || !country) continue

			let tally = tallies.get(country)

			if (!tally) {
				tally = {
					withRegion: 0,
					region: 0,
					secondLevelOnly: 0,
					neither: 0,
					secondLevelOnlyBySource: new Map(),
					secondLevelOnlyValues: new Map(),
				}

				tallies.set(country, tally)
			}

			tally.withRegion++

			if (regions.holds(country, value) !== false) {
				tally.region++
			} else if (secondLevel.holds(country, value)) {
				tally.secondLevelOnly++
				increment(tally.secondLevelOnlyBySource, String(row.source))
				increment(tally.secondLevelOnlyValues, value)
			} else {
				tally.neither++
			}
		}
	}

	if ((index + 1) % 50 === 0) {
		console.log(`${index + 1}/${manifest.files.length} files, ${Math.round((Date.now() - started) / 1000)}s`)
	}
}

const top = (map: Map<string, number>) =>
	Object.fromEntries([...map].toSorted((a, b) => b[1] - a[1]).slice(0, TOP_VALUES))

const countries = [...tallies]
	.map(([country, tally]) => ({
		country,
		withRegion: tally.withRegion,
		region: tally.region,
		secondLevelOnly: tally.secondLevelOnly,
		neither: tally.neither,
		secondLevelShare: tally.secondLevelOnly / tally.withRegion,
		secondLevelOnlyBySource: top(tally.secondLevelOnlyBySource),
		secondLevelOnlyValues: top(tally.secondLevelOnlyValues),
	}))
	.toSorted((a, b) => b.secondLevelShare - a.secondLevelShare)

const table: SecondLevelRegionTable = {
	$description:
		"Per country, the base rows with a region and those whose region is a second-level (WOF county) name " +
		"of the country and no region name of it. Written by packages/corpus/lib/tools/region-slot-census.run.ts; " +
		"secondLevelAdmitted in packages/corpus/lib/build/region/names.ts decides which countries the region:unknown rule admits.",
	manifest: manifestPath,
	countries: Object.fromEntries(
		countries
			.toSorted((a, b) => a.country.localeCompare(b.country))
			.map((country) => [country.country, { withRegion: country.withRegion, secondLevelOnly: country.secondLevelOnly }])
	),
}

await writeLocalJSONFile(
	{
		manifest: manifestPath,
		database: database.toString(),
		seconds: Math.round((Date.now() - started) / 1000),
		baseRows,
		unread,
		admitted: secondLevelAdmitted(table),
		countries,
	},
	outPath
)

if (values.table) {
	await writeLocalJSONFile(table, values.table)
}

console.log(`done: ${secondLevelAdmitted(table).length} admitted of ${countries.length} countries`)
