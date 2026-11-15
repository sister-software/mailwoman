// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * Times `computeQueryShape(input)` on the six inputs of the issue's timing table (#3064).
 *
 * It also times the UTF-8 encode and decode of the same string that a WebAssembly
 * call pays before it starts.
 *
 * Method: 20,000 warm-up calls, then 200,000 timed calls per input, in one Node process.
 * Every result feeds a running sum so the engine cannot drop the work.
 * The tool makes no assertion on the numbers.
 *
 * Phases 3, 6 and 9 of the issue rerun this tool against the replacement and compare per input.
 *
 * Usage: `node packages/mailwoman/tools/dev-tools/query-shape/bench.run.ts [--json]`
 */

import { gitHead } from "@mailwoman/core/git"
import { prettyJSON } from "@mailwoman/core/json"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { cpuModel } from "@mailwoman/core/utils/system"
import { computeQueryShape } from "@mailwoman/query-shape"

const WARM_UP_CALLS = 20_000
const TIMED_CALLS = 200_000

/**
 * The Markdown table truncates the label of an input longer than this length in UTF-16 units.
 */
const LABEL_MAX_UNITS = 80

const WHITE_HOUSE = "1600 Pennsylvania Avenue NW, Washington, DC 20500, United States of America"

/**
 * The inputs of the issue's timing table, in its order.
 */
const INPUTS: readonly string[] = [
	"68161",
	"SW1A 1AA",
	"350 5th Ave, New York, NY 10118",
	"〒100-0001 東京都千代田区千代田1-1",
	"金龍酒家, 12 Gerrard Street, London WC2H 7JS",
	WHITE_HOUSE.repeat(4),
]

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/**
 * Microseconds per call of `run(input)` over {@link TIMED_CALLS} calls
 * after {@link WARM_UP_CALLS} warm-up calls.
 */
function microsecondsPerCall(input: string, run: (input: string) => number): { microseconds: number; sink: number } {
	let sink = 0

	for (let call = 0; call < WARM_UP_CALLS; call++) {
		sink += run(input)
	}

	const start = process.hrtime.bigint()

	for (let call = 0; call < TIMED_CALLS; call++) {
		sink += run(input)
	}

	const nanoseconds = Number(process.hrtime.bigint() - start)

	return { microseconds: nanoseconds / TIMED_CALLS / 1000, sink }
}

const rows = INPUTS.map((input) => {
	const shape = microsecondsPerCall(input, (text) => computeQueryShape(text).totalLength)
	const codec = microsecondsPerCall(input, (text) => decoder.decode(encoder.encode(text)).length)

	return {
		input,
		utf16Units: input.length,
		utf8Bytes: encoder.encode(input).length,
		computeQueryShapeMicroseconds: shape.microseconds,
		utf8RoundTripMicroseconds: codec.microseconds,
		sink: shape.sink + codec.sink,
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
	console.log("| Input | UTF-16 units | UTF-8 bytes | computeQueryShape (µs/call) | UTF-8 encode+decode (µs/call) |")
	console.log("| --- | --- | --- | --- | --- |")

	for (const row of rows) {
		const label =
			row.utf16Units > LABEL_MAX_UNITS ? `${row.input.slice(0, 40)}… (×4, ${row.utf16Units} units)` : row.input

		console.log(
			`| \`${label}\` | ${row.utf16Units} | ${row.utf8Bytes} | ${row.computeQueryShapeMicroseconds.toFixed(2)} | ${row.utf8RoundTripMicroseconds.toFixed(2)} |`
		)
	}
}
