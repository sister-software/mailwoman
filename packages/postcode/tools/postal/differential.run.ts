// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Runs `acceptingCountries` of the `postal` family and `countriesAcceptingPostcode`
 *   over real strings and writes `data/reports/postal-differential.json`: the sources,
 *   the counts, the number of differing inputs, and every differing input with both answers.
 *
 *   Sources, every row of each, in file order, with no sampling:
 *
 *   - The postcode-tagged spans of the held-out development and confirmation
 *     rows of dataset `v0.8.18.v2`, under the data root's `corpus/heldout/`:
 *     `raw.slice(span_starts[i], span_ends[i])` for each span tagged `postcode`.
 *   - The whole `raw` string of each of those rows.
 *     No country's syntax should accept an address, so the comparison also
 *     covers strings that aren't postcodes.
 *   - The `expectComponents.postcode` of each gauntlet case
 *     under `packages/mailwoman/tools/eval-harness/gauntlet/cases/`.
 *   - The `input` of each gauntlet case.
 *
 *   Usage:
 *   `node --max-old-space-size=8192 packages/postcode/tools/postal/differential.run.ts [--out <path>] [--cap <n>]`
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { readLocalTextFile, sortedGlob } from "@mailwoman/core/fs/readers"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { prettyJSON } from "@mailwoman/core/json"
import { workspacePath } from "@mailwoman/core/paths"
import { parseArguments } from "@mailwoman/core/scripting/arguments"

import { countriesAcceptingPostcode } from "#country-formats"
import { type AcceptingDifference, compareAccepting } from "#tools/postal/differential"

const { values } = parseArguments({
	options: {
		out: {
			type: "string",
			default: workspacePath("postcode", "data", "reports", "postal-differential.json").toString(),
		},
		cap: { type: "string", default: "200" },
	},
})

const cap = Number(values.cap)
const HELDOUT = ["heldout-dev-v0.8.18.v2.rows.jsonl", "heldout-confirm-v0.8.18.v2.rows.jsonl"]

interface Source {
	name: string
	inputs: string[]
}

/**
 * Reads each line of a JSON Lines file as an object.
 *
 * A line that isn't JSON throws, because a missing row would make the count wrong.
 */
async function readRows(path: string): Promise<Array<Record<string, unknown>>> {
	const text = await readLocalTextFile(path)
	const rows: Array<Record<string, unknown>> = []

	// oxlint-disable-next-line mailwoman/prefer-spliterator -- the largest file is 24 MB and each line is read once
	for (const line of text.split("\n")) {
		if (!line) continue

		// oxlint-disable-next-line no-restricted-properties -- each line is a JSON object this tool reads fields of
		rows.push(JSON.parse(line) as Record<string, unknown>)
	}

	return rows
}

/**
 * The text of the postcode-tagged spans of one held-out row.
 */
function postcodeSpans(row: Record<string, unknown>): string[] {
	const { raw, span_starts: starts, span_tags: tags, span_ends: ends } = row

	if (typeof raw !== "string" || !Array.isArray(starts) || !Array.isArray(ends) || !Array.isArray(tags)) {
		throw new TypeError("a held-out row lacks raw, span_starts, span_ends or span_tags")
	}

	return tags.flatMap((tag, index) =>
		tag === "postcode" ? [raw.slice(starts[index] as number, ends[index] as number)] : []
	)
}

const sources: Source[] = []

for (const file of HELDOUT) {
	const rows = await readRows(dataRootPath("corpus", "heldout", file).toString())

	sources.push({ name: `corpus/heldout/${file}: postcode spans`, inputs: rows.flatMap(postcodeSpans) })
	sources.push({ name: `corpus/heldout/${file}: raw`, inputs: rows.map((row) => String(row.raw)) })
}

const gauntlet = workspacePath("mailwoman", "tools", "eval-harness", "gauntlet", "cases").toString()
const cases: Array<Record<string, unknown>> = []

for (const file of await sortedGlob(gauntlet, "*/*.jsonl")) {
	cases.push(...(await readRows(file.toString())))
}

sources.push({
	name: "gauntlet cases: expectComponents.postcode",
	inputs: cases.flatMap((row) => {
		const postcode = (row.expectComponents as Record<string, unknown> | undefined)?.postcode

		return typeof postcode === "string" ? [postcode] : []
	}),
})

sources.push({ name: "gauntlet cases: input", inputs: cases.map((row) => String(row.input)) })

const differences: AcceptingDifference[] = []
const report: Array<Record<string, unknown>> = []
let total = 0
let differing = 0

for (const source of sources) {
	let sourceDiffering = 0
	let accepted = 0

	for (const input of source.inputs) {
		const difference = compareAccepting(input)

		if (difference) {
			sourceDiffering++

			differing++

			if (differences.length < cap) {
				differences.push(difference)
			}
		} else if (countriesAcceptingPostcode(input).length) {
			accepted++
		}
	}

	total += source.inputs.length

	report.push({
		source: source.name,
		inputs: source.inputs.length,
		differing: sourceDiffering,
		acceptedByAnyCountry: accepted,
	})
}

const summary = {
	comparison: "acceptingCountries of the postal family against countriesAcceptingPostcode",
	sampling: "every input of every source, in file order; no sampling and no deduplication",
	inputs: total,
	differing,
	differencesListed: differences.length,
	differencesCap: cap,
	sources: report,
	differences,
}

await writeLocalTextFile(prettyJSON(summary), values.out)

console.log(`${total} inputs, ${differing} differing; wrote ${values.out}`)

if (differing) {
	process.exitCode = 1
}
