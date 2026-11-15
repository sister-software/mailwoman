// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Times one `recognizer.recognize(input)` call with the `structure`, `postcode_legacy`,
 *   `primitives` and `coordinates` families composed, against `computeQueryShape` in the
 *   same process, on the eight inputs of `packages/recognize/tools/bench.run.ts`.
 *
 *   The recognizer computes every field `computeQueryShape` does, known formats included,
 *   and also recognizes digit runs, decimals, whitespace, words and decimal pairs,
 *   so it does more work on each input.
 *   The requirement is that one call takes no longer than `computeQueryShape`.
 *
 *   Method: 20,000 warm-up calls, then 200,000 timed calls per input, in one Node process.
 *   Every result feeds a running sum so the engine cannot drop the work.
 *
 *   Run it on a host with no CI run in progress, because busy runners slow both sides two to three times.
 *
 *   The tool lives in this package and not beside the `recognize` benchmark because it
 *   imports `@mailwoman/postcode`, and `@mailwoman/recognize` mustn't import that package.
 *
 *   Usage: `node packages/postcode/tools/bench.run.ts [--json]`
 */

import { gitHead } from "@mailwoman/core/git"
import { prettyJSON } from "@mailwoman/core/json"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { cpuModel } from "@mailwoman/core/utils/system"
import { computeQueryShape } from "@mailwoman/query-shape"
import { createRecognizer } from "@mailwoman/recognize"
import { coordinates } from "@mailwoman/recognize/coordinates"
import { primitives } from "@mailwoman/recognize/primitives"
import { structure } from "@mailwoman/recognize/structure"

import { postcodeLegacy } from "#recognize"

const WARM_UP_CALLS = 20_000
const TIMED_CALLS = 200_000
const LABEL_MAX_UNITS = 80

const WHITE_HOUSE = "1600 Pennsylvania Avenue NW, Washington, DC 20500, United States of America"

/**
 * The inputs of the `recognize` benchmark, the issue's timing table.
 */
const INPUTS: readonly string[] = [
	"68161",
	"SW1A 1AA",
	"350 5th Ave, New York, NY 10118",
	"〒100-0001 東京都千代田区千代田1-1",
	"金龍酒家, 12 Gerrard Street, London WC2H 7JS",
	WHITE_HOUSE.repeat(4),
	"1".repeat(300),
	"漢".repeat(300),
]

const recognizer = createRecognizer([structure, postcodeLegacy, primitives, coordinates])

function microsecondsPerCall(input: string, run: (input: string) => number): { microseconds: number; sink: number } {
	let sink = 0

	for (let call = 0; call < WARM_UP_CALLS; call++) {
		sink += run(input)
	}

	const start = process.hrtime.bigint()

	for (let call = 0; call < TIMED_CALLS; call++) {
		sink += run(input)
	}

	return { microseconds: Number(process.hrtime.bigint() - start) / TIMED_CALLS / 1000, sink }
}

const encoder = new TextEncoder()

const rows = INPUTS.map((input) => {
	const legacy = microsecondsPerCall(input, (text) => computeQueryShape(text).knownFormats.length)
	const adapter = microsecondsPerCall(input, (text) => recognizer.recognize(text).fields.knownFormats.length)

	return {
		input,
		utf16Units: input.length,
		utf8Bytes: encoder.encode(input).length,
		knownFormats: recognizer.recognize(input).fields.knownFormats.length,
		computeQueryShapeMicroseconds: legacy.microseconds,
		recognizeMicroseconds: adapter.microseconds,
		sink: legacy.sink + adapter.sink,
	}
})

const report = {
	commit: await gitHead(),
	node: process.version,
	cpu: cpuModel(),
	warmUpCalls: WARM_UP_CALLS,
	timedCalls: TIMED_CALLS,
	rows,
}

const { values } = parseArguments({ options: { json: { type: "boolean", default: false } } })

if (values.json) {
	console.log(prettyJSON(report))
} else {
	console.log(`commit ${report.commit}, node ${report.node}, ${report.cpu}`)
	console.log(`${WARM_UP_CALLS} warm-up calls, then ${TIMED_CALLS} timed calls per input\n`)
	console.log("| Input | UTF-16 units | Known formats | computeQueryShape (µs/call) | recognize (µs/call) |")
	console.log("| --- | --- | --- | --- | --- |")

	for (const row of rows) {
		const label = row.utf16Units > LABEL_MAX_UNITS ? `${row.input.slice(0, 40)}… (${row.utf16Units} units)` : row.input

		console.log(
			`| \`${label}\` | ${row.utf16Units} | ${row.knownFormats} | ${row.computeQueryShapeMicroseconds.toFixed(2)} | ${row.recognizeMicroseconds.toFixed(2)} |`
		)
	}
}
