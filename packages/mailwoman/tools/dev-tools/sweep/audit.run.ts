// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Lists every key or value line a commit added to a data file, so a reviewer can check whether a vocabulary sweep
 *   rewrote a stored string such as a corpus `source` id or a `source_weights` key. The tool reports and does not
 *   judge: a rewritten prose field in a JSON document can be correct.
 *
 *   Usage: node packages/mailwoman/tools/dev-tools/sweep/audit.run.ts --commit <rev> [--lines 6]
 */

import { git } from "@mailwoman/core/git"
import { integerArgument, parseArguments, requiredArgument } from "@mailwoman/core/scripting/arguments"
import { TextSpliterator } from "spliterator"

import { classifyDataDiff, DATA_EXTENSIONS, type DataDiffReport, extensionOf, numstatDestination } from "./audit.ts"

const { values } = parseArguments({
	options: {
		commit: { type: "string" },
		lines: { type: "string", default: "6" },
	},
})

const commit = requiredArgument("sweep/audit", "commit", values.commit)
const shownLines = integerArgument("lines", values.lines)

/**
 * A vocabulary sweep's diff can exceed the helper's default output buffer.
 */
const DIFF_MAX_BUFFER = 256 * 1024 * 1024

const show = (args: string[]) => git(["show", "--format=", "-M", ...args], undefined, DIFF_MAX_BUFFER)

const paths = TextSpliterator.from(await show(["--numstat", commit]))
	// oxlint-disable-next-line mailwoman/prefer-spliterator -- one numstat line holds exactly three fields
	.map((line) => line.split("\t")[2])
	.filter((path): path is string => typeof path === "string" && path.length > 0)
	.map(numstatDestination)
	.filter((path) => DATA_EXTENSIONS.has(extensionOf(path)))
	.toArray()

console.log(`${paths.length} data file(s) touched by ${commit}\n`)

const reports: DataDiffReport[] = []

for (const path of paths) {
	const report = classifyDataDiff(path, await show([commit, "--", path]))

	if (report.valueLines.length) {
		reports.push(report)
	}
}

reports.sort((a, b) => b.valueLines.length - a.valueLines.length)

let totalValueLines = 0

for (const report of reports) {
	totalValueLines += report.valueLines.length

	console.log(`${report.path}: ${report.valueLines.length} value line(s), ${report.commentLines} comment line(s)`)

	for (const line of report.valueLines.slice(0, shownLines)) {
		console.log(`      ${line.slice(0, 160)}`)
	}

	if (report.valueLines.length > shownLines) {
		console.log(`      … ${report.valueLines.length - shownLines} more`)
	}

	console.log()
}

console.log(`${reports.length} of ${paths.length} data file(s) carry ${totalValueLines} added value line(s).`)
