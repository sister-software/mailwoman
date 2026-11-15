// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Times one `recognizer.recognize(input)` call through the WebAssembly adapter on
 *   the six inputs of `packages/mailwoman/tools/dev-tools/query-shape/bench.run.ts`,
 *   with `computeQueryShape` timed in the same process.
 *
 *   Method: 20,000 warm-up calls, then 200,000 timed calls per input,
 *   in one Node process, the legacy tool's method.
 *   Every result feeds a running sum so the engine cannot drop the work.
 *
 *   The recognizer is composed from the `primitives` and `coordinates` families.
 *
 *   The two do not do the same work.
 *   `computeQueryShape` computes character class, scripts, segments and known formats,
 *   and the two families recognize digit runs, decimals, whitespace, words and decimal pairs.
 *
 *   The comparison therefore measures the cost of crossing the boundary
 *   (encode, call, decode, convert offsets) and gives no estimate of the speed of a `structure` family.
 *   The tool makes no assertion on the numbers.
 *
 *   The tool lives here and not beside the legacy benchmark because it imports `@mailwoman/query-shape`,
 *   which `@mailwoman/recognize` takes as a development dependency for this comparison.
 *
 *   Usage: `node packages/recognize/tools/bench.run.ts [--json]`
 */

import { gitHead } from "@mailwoman/core/git"
import { prettyJSON } from "@mailwoman/core/json"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { cpuModel } from "@mailwoman/core/utils/system"
import { computeQueryShape } from "@mailwoman/query-shape"

import { coordinates } from "#coordinates"
import { createRecognizer } from "#index"
import { primitives } from "#primitives"

const WARM_UP_CALLS = 20_000
const TIMED_CALLS = 200_000
const LABEL_MAX_UNITS = 80

const WHITE_HOUSE = "1600 Pennsylvania Avenue NW, Washington, DC 20500, United States of America"

/**
 * The inputs of the issue's timing table, in the legacy benchmark's order.
 */
const INPUTS: readonly string[] = [
	"68161",
	"SW1A 1AA",
	"350 5th Ave, New York, NY 10118",
	"〒100-0001 東京都千代田区千代田1-1",
	"金龍酒家, 12 Gerrard Street, London WC2H 7JS",
	WHITE_HOUSE.repeat(4),
]

const recognizer = createRecognizer([primitives, coordinates])

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
	const legacy = microsecondsPerCall(input, (text) => computeQueryShape(text).totalLength)
	const adapter = microsecondsPerCall(input, (text) => recognizer.recognize(text).recognitions.length)

	return {
		input,
		utf16Units: input.length,
		utf8Bytes: encoder.encode(input).length,
		candidates: recognizer.recognize(input).recognitions.length,
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
	console.log("| Input | UTF-16 units | Candidates | computeQueryShape (µs/call) | recognize (µs/call) |")
	console.log("| --- | --- | --- | --- | --- |")

	for (const row of rows) {
		const label =
			row.utf16Units > LABEL_MAX_UNITS ? `${row.input.slice(0, 40)}… (×4, ${row.utf16Units} units)` : row.input

		console.log(
			`| \`${label}\` | ${row.utf16Units} | ${row.candidates} | ${row.computeQueryShapeMicroseconds.toFixed(2)} | ${row.recognizeMicroseconds.toFixed(2)} |`
		)
	}
}
