// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Splits the cost of one `recognizer.recognize(input)` call into the stages of the JavaScript side.
 *
 *   Method: each stage runs in its own loop of 20,000 warm-up calls and 200,000 timed calls, over state
 *   the previous stage left in place, so the timer is read twice per loop and never inside a call.
 *   A loop's cost is the stage plus its own loop overhead.
 *
 *   The stages are summed and compared with the whole call timed the same way.
 *   The difference is the residue.
 *
 *   The residue is the cache and allocation interactions of the stages running together.
 *   Most of it is garbage collection of the objects a call returns.
 *
 *   An isolated loop over reused objects doesn't pay that cost.
 *   The closure and property reads between the stages add the rest.
 *
 *   The stages, in the order a call runs them:
 *
 *   - `encode`: `TextEncoder.encodeInto` straight into the reused staging memory.
 *   - `call`: the exported `rcg_recognize`, which searches, extracts and validates
 *     and writes the result records.
 *   - `read`: the records read from linear memory into the returned objects,
 *     with the byte-to-UTF-16 conversion.
 *   - `structure`: the `rcg_structure` call and the objects built from its binary result.
 *
 *   The native split of `call` is `crates/recognizer-wasm/examples/stages.rs`.
 *   The first version of this tool timed a serialized JSON document, and so also had stages `read`
 *   (the copy out of linear memory) and `decode` (`JSON.parse`), which the binary records removed.
 *
 *   Usage: `node packages/recognizer/tools/profile.run.ts [--json]`
 */

import { gitHead } from "@mailwoman/core/repo/git"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { cpuModel } from "@mailwoman/core/utils/system"
import { prettyJSON } from "@mailwoman/core/values/json"

import { coordinates } from "#coordinates"
import { createRecognizer } from "#index"
import { primitives } from "#primitives"
import { loadFamily, readRecognitions } from "#runtime/engine"
import { ready } from "#runtime/state"
import { structureFields } from "#runtime/structure"
import { structure } from "#structure"

const WARM_UP_CALLS = 20_000
const TIMED_CALLS = 200_000

/**
 * The input length past which the table shows a prefix, as the legacy benchmark does.
 */
const LABEL_MAX_UNITS = 80

const WHITE_HOUSE = "1600 Pennsylvania Avenue NW, Washington, DC 20500, United States of America"

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

// The first call instantiates the engine and loads both families.
recognizer.recognize("1")

const instance = ready()
const structureHandle = loadFamily(instance, structure)
const mask = (1 << loadFamily(instance, primitives)) | (1 << loadFamily(instance, coordinates)) | (1 << structureHandle)
const encoder = new TextEncoder()

function microsecondsPerCall(run: () => number): { microseconds: number; sink: number } {
	let sink = 0

	for (let call = 0; call < WARM_UP_CALLS; call++) {
		sink += run()
	}

	const start = process.hrtime.bigint()

	for (let call = 0; call < TIMED_CALLS; call++) {
		sink += run()
	}

	return { microseconds: Number(process.hrtime.bigint() - start) / TIMED_CALLS / 1000, sink }
}

const rows = INPUTS.map((input) => {
	const { exports } = instance
	const wanted = input.length * 3
	const pointer = exports.rcg_alloc(wanted)
	let written = 0

	const encode = microsecondsPerCall(() => {
		written = encoder.encodeInto(input, new Uint8Array(exports.memory.buffer, pointer, wanted)).written

		return written
	})

	let count = 0

	const call = microsecondsPerCall(() => {
		count = exports.rcg_recognize(pointer, written, mask)

		return count
	})

	const read = microsecondsPerCall(() => readRecognitions(instance, input, written, count).length)
	// The structure call's staged text is already encoded, so this stage is the engine call and the object building.
	const fields = microsecondsPerCall(() => structureFields(instance, input, structureHandle).tokenClasses.length)
	const whole = microsecondsPerCall(() => recognizer.recognize(input).recognitions.length)

	exports.rcg_dealloc(pointer, wanted)

	const stages = {
		encode: encode.microseconds,
		call: call.microseconds,
		read: read.microseconds,
		structure: fields.microseconds,
	}

	const sum = Object.values(stages).reduce((total, value) => total + value, 0)

	return {
		input,
		utf16Units: input.length,
		utf8Bytes: written,
		recognitions: count,
		...stages,
		sum,
		whole: whole.microseconds,
		residue: whole.microseconds - sum,
		sink: encode.sink + call.sink + read.sink + fields.sink + whole.sink,
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
	console.log(`${WARM_UP_CALLS} warm-up calls, then ${TIMED_CALLS} timed calls per stage and input (µs/call)\n`)
	console.log("| Input | Recognitions | encode | call | read | structure | sum | whole | residue |")
	console.log("| --- | --- | --- | --- | --- | --- | --- | --- | --- |")

	for (const row of rows) {
		const label = row.utf16Units > LABEL_MAX_UNITS ? `${row.input.slice(0, 30)}… (×4)` : row.input

		console.log(
			`| \`${label}\` | ${row.recognitions} | ${row.encode.toFixed(2)} | ${row.call.toFixed(2)} | ${row.read.toFixed(2)} | ${row.structure.toFixed(2)} | ${row.sum.toFixed(2)} | ${row.whole.toFixed(2)} | ${row.residue.toFixed(2)} |`
		)
	}
}
