// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Prints a config's expected draws per source and, with `--previous`, every source whose
 *   draws fell by more than `--bound` (default 0.05) from the previous config's run.
 *   Exits 1 when such a fall exists.
 *
 *   Each config is read against its own corpus on the host (`rerootToHost`).
 *
 *   Usage:
 *     node packages/mailwoman/tools/training/draw/report.run.ts --config <yaml> [--previous <yaml>] [--bound 0.05] \
 *       [--tsv <path>] [--countries <path>]
 *
 *   `--countries` writes the expected draws per country (`expectedCountryDraws`),
 *   reading every data file's rows by source and country.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { escapeSQLString, openDuckDB } from "@mailwoman/corpus/parquet/duckdb"
import { baseManifestFiles } from "@mailwoman/corpus/tools/overlay/manifest"
import { mtfNode } from "@mailwoman/mtf/tools/sampler/native"

import { loadTrainingConfig, rerootToHost } from "../config.ts"
import { hostPath } from "../sampler.ts"
import { drawFalls, expectedCountryDraws, expectedDraws, type SourceCountryRows } from "./report.ts"

const { values } = parseArguments({
	options: {
		config: { type: "string" },
		previous: { type: "string" },
		bound: { type: "string", default: "0.05" },
		tsv: { type: "string" },
		countries: { type: "string" },
	},
})

if (!values.config) throw new Error("--config is required")

const mtf = await mtfNode()

/**
 * Each source's train rows per country: every data file's rows by source and country,
 * read with DuckDB, times the file's train share from its split attribute's counts.
 */
async function trainRowsByCountry(corpusDir: string): Promise<SourceCountryRows[]> {
	const manifest = await readLocalJSONFile<object>(`${corpusDir}/MANIFEST.json`)

	const files = baseManifestFiles<{ path: string; rows: number; split_attribute?: { counts?: { train?: number } } }>(
		manifest
	)

	const totals = new Map<string, SourceCountryRows>()

	using db = await openDuckDB({ threads: 4, memoryLimitBytes: 4 * 1024 ** 3 })

	for (const file of files) {
		const train = file.split_attribute?.counts?.train

		if (train == null) throw new Error(`${file.path} records no train count in its split attribute`)

		const share = file.rows > 0 ? train / file.rows : 0

		const reader = await db.runAndReadAll(
			`SELECT source, country, count(*)::BIGINT AS n FROM read_parquet('${escapeSQLString(hostPath(file.path))}') GROUP BY 1, 2`
		)

		for (const row of reader.getRowObjectsJson() as Array<{ source: string; country: string | null; n: string }>) {
			const country = row.country ?? ""
			const key = `${row.source}\u001F${country}`
			const entry = totals.get(key) ?? { source: row.source, country, rows: 0 }

			entry.rows += Number(row.n) * share
			totals.set(key, entry)
		}
	}

	return [...totals.values()]
}

const drawsOf = async (path: string) => {
	const config = rerootToHost(await loadTrainingConfig(path))

	return { config, draws: expectedDraws(mtf, config, config.data.corpus_dir) }
}

const current = await drawsOf(values.config)
const samples = current.draws.reduce((sum, { draws }) => sum + draws, 0)
const lines = ["source\ttrain_rows\texpected_draws\tdraws_per_row\tshare"]

for (const { source, rows, draws } of current.draws.toSorted((a, b) => b.draws - a.draws)) {
	lines.push(
		`${source}\t${rows}\t${Math.round(draws)}\t${rows ? (draws / rows).toFixed(4) : ""}\t${(draws / samples).toFixed(4)}`
	)
}

if (values.tsv) {
	await writeLocalTextFile(`${lines.join("\n")}\n`, values.tsv)
}

console.log(`${values.config}: ${Math.round(samples)} draws over ${current.draws.length} sources`)
console.log(lines.slice(0, 16).join("\n"))

if (values.countries) {
	const countryRows = await trainRowsByCountry(current.config.data.corpus_dir)
	const countries = expectedCountryDraws(current.draws, countryRows, current.config.data.country_weights)
	const table = ["country\ttrain_rows\texpected_draws\tdraws_per_row\tshare"]

	for (const { country, rows, draws } of countries) {
		table.push(
			`${country}\t${Math.round(rows)}\t${Math.round(draws)}\t${rows ? (draws / rows).toFixed(4) : ""}\t${(draws / samples).toFixed(4)}`
		)
	}

	await writeLocalTextFile(`${table.join("\n")}\n`, values.countries)

	console.log(`\n${countries.length} countries → ${values.countries}`)
	console.log(table.slice(0, 11).join("\n"))
}

if (values.previous) {
	const previous = await drawsOf(values.previous)
	const bound = Number(values.bound)
	const falls = drawFalls(previous.draws, current.draws, bound)

	console.log(`\nAgainst ${values.previous}: ${falls.length} sources fell by more than ${bound}`)

	for (const { source, previous: before, current: after, fall } of falls) {
		console.log(`  ${source}\t${Math.round(before)} → ${Math.round(after)}\t−${(100 * fall).toFixed(1)}%`)
	}

	if (falls.length) {
		process.exitCode = 1
	}
}
