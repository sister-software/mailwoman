// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Times one `recognizer.recognize(input)` call through the WebAssembly adapter on eight inputs:
 *   the six of the issue's timing table, a 300-digit run and a 300-character run of one CJK character.
 *
 *   Method: 20,000 warm-up calls, then 200,000 timed calls per input, in one Node process.
 *   Every result feeds a running sum so the engine cannot drop the work.
 *
 *   The recognizer is composed from the `structure`, `primitives` and `coordinates` families.
 *   It doesn't compute known formats, because the `postcode_legacy` family belongs
 *   to `@mailwoman/postcode`, and this package mustn't import it.
 *
 *   `packages/postcode/tools/bench.run.ts` times the same inputs with that family composed.
 *
 *   The tool makes no assertion on the numbers.
 *   The numbers of the removed legacy implementation, taken in the same process
 *   before it was deleted, are in `docs/records/engineering/2026-11-16-recognize-swap.md`.
 *
 *   Usage: `node packages/recognizer/tools/bench.run.ts [--json]`
 */

import { gitHead } from "@mailwoman/core/git"
import { prettyJSON } from "@mailwoman/core/json"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { cpuModel } from "@mailwoman/core/utils/system"

import { coordinates } from "#coordinates"
import { createRecognizer } from "#index"
import { primitives } from "#primitives"
import { structure } from "#structure"

const WARM_UP_CALLS = 20_000
const TIMED_CALLS = 200_000
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
	"1".repeat(300),
	"漢".repeat(300),
]

const recognizer = createRecognizer([structure, primitives, coordinates])

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
	const adapter = microsecondsPerCall(input, (text) => recognizer.recognize(text).recognitions.length)

	return {
		input,
		utf16Units: input.length,
		utf8Bytes: encoder.encode(input).length,
		candidates: recognizer.recognize(input).recognitions.length,
		recognizeMicroseconds: adapter.microseconds,
		sink: adapter.sink,
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
	console.log("| Input | UTF-16 units | Candidates | recognize (µs/call) |")
	console.log("| --- | --- | --- | --- |")

	for (const row of rows) {
		const label = row.utf16Units > LABEL_MAX_UNITS ? `${row.input.slice(0, 40)}… (${row.utf16Units} units)` : row.input

		console.log(`| \`${label}\` | ${row.utf16Units} | ${row.candidates} | ${row.recognizeMicroseconds.toFixed(2)} |`)
	}
}
