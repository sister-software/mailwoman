// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Runs the `structure` family and `computeQueryShape` over real address strings and writes
 *   `data/reports/structure-differential.json`: the sources, the counts, the number of
 *   differing rows, and every differing row with both outputs, capped with the total stated.
 *
 *   Sources, every row of each, in file order, with no sampling:
 *
 *   - The held-out development and confirmation rows of dataset `v0.8.18.v2`,
 *     under the data root's `corpus/heldout/`.
 *     A row's `raw` field is the address string.
 *     The files hold rows from OpenStreetMap, Who's On First, GeoNames and other sources,
 *     in Latin, Cyrillic, Arabic, Han, Kana and Hangul text.
 *   - The gauntlet cases under `packages/mailwoman/tools/eval-harness/gauntlet/cases/`.
 *     A case's `input` field is the string.
 *
 *   The tool reads each file whole, because the largest is 24 MB.
 *
 *   Usage: `node --max-old-space-size=8192 packages/recognize/tools/differential.run.ts [--out <path>] [--cap <n>]`
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { readLocalTextFile, sortedGlob } from "@mailwoman/core/fs/readers"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { prettyJSON } from "@mailwoman/core/json"
import { workspacePath } from "@mailwoman/core/paths"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { computeQueryShape } from "@mailwoman/query-shape"

import { type Difference, compareOne } from "#tools/differential"

const { values } = parseArguments({
	options: {
		out: {
			type: "string",
			default: workspacePath("recognize", "data", "reports", "structure-differential.json").toString(),
		},
		cap: { type: "string", default: "200" },
	},
})

const cap = Number(values.cap)

const HELDOUT = ["heldout-dev-v0.8.18.v2.rows.jsonl", "heldout-confirm-v0.8.18.v2.rows.jsonl"]

interface Source {
	name: string
	field: string
	path: string
	rows: string[]
}

/**
 * Reads the string field of each line of a JSON Lines file.
 *
 * A line that's not JSON or lacks the field throws, because a missing row would make the count wrong.
 */
async function readStrings(path: string, field: string): Promise<string[]> {
	const text = await readLocalTextFile(path)
	const rows: string[] = []

	// oxlint-disable-next-line mailwoman/prefer-spliterator -- the largest file is 24 MB and each line is read once
	for (const line of text.split("\n")) {
		if (!line) continue

		// oxlint-disable-next-line no-restricted-properties -- each line is a JSON object this tool reads one field of
		const value = (JSON.parse(line) as Record<string, unknown>)[field]

		if (typeof value !== "string") throw new Error(`${path}: a row has no string field \`${field}\``)

		rows.push(value)
	}

	return rows
}

const sources: Source[] = []

for (const file of HELDOUT) {
	const path = dataRootPath("corpus", "heldout", file).toString()

	sources.push({ name: `corpus/heldout/${file}`, field: "raw", path, rows: await readStrings(path, "raw") })
}

const gauntlet = workspacePath("mailwoman", "tools", "eval-harness", "gauntlet", "cases").toString()
const gauntletFiles = await sortedGlob(gauntlet, "*/*.jsonl")
const gauntletRows: string[] = []

for (const file of gauntletFiles) {
	gauntletRows.push(...(await readStrings(file.toString(), "input")))
}

sources.push({
	name: "packages/mailwoman/tools/eval-harness/gauntlet/cases/*/*.jsonl",
	field: "input",
	path: gauntlet,
	rows: gauntletRows,
})

const differences: Difference[] = []
const report: Array<Record<string, unknown>> = []
let total = 0
let differing = 0

for (const source of sources) {
	const classes: Record<string, number> = {}
	const scripts: Record<string, number> = {}
	let sourceDiffering = 0

	for (const row of source.rows) {
		const difference = compareOne(row)

		if (difference) {
			sourceDiffering++

			differing++

			if (differences.length < cap) {
				differences.push(difference)
			}
		}

		// The legacy value is the oracle for the coverage counts, and the comparison already holds the two equal.
		const shape = computeQueryShape(row)

		classes[shape.characterClass] = (classes[shape.characterClass] ?? 0) + 1

		for (const { script } of shape.scripts) {
			scripts[script] = (scripts[script] ?? 0) + 1
		}
	}

	total += source.rows.length

	report.push({
		source: source.name,
		field: source.field,
		rows: source.rows.length,
		differingRows: sourceDiffering,
		rowsByCharacterClass: classes,
		rowsContainingScript: scripts,
	})
}

const summary = {
	comparison: "recognize with the structure family against computeQueryShape, the six fields",
	fields: ["characterClass", "scripts", "tokenClasses", "segments", "regionAbbreviations", "totalLength"],
	sampling: "every row of every source, in file order; no sampling and no deduplication",
	rows: total,
	differingRows: differing,
	differencesListed: differences.length,
	differencesCap: cap,
	sources: report,
	differences,
}

await writeLocalTextFile(prettyJSON(summary), values.out)

console.log(`${total} rows, ${differing} differing; wrote ${values.out}`)

if (differing) {
	process.exitCode = 1
}
