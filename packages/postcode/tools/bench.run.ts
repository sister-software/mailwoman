// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Times one `recognizer.recognize(input)` call with the `structure`,
 *   `postcode_legacy`, `primitives` and `coordinates` families composed,
 *   on the eight inputs of `packages/recognizer/tools/bench.run.ts`.
 *
 *   The recognizer computes the structural fields and known formats, and also recognizes
 *   digit runs, decimals, whitespace, words and the coordinate spellings.
 *   Further columns add the `postal` family, and the `spatial` and `identifiers`
 *   families, to that composition.
 *
 *   The numbers of the removed legacy implementation, taken in the same process
 *   before it was deleted, are in `docs/records/engineering/2026-11-16-recognize-swap.md`.
 *
 *   Method: 20,000 warm-up calls, then 200,000 timed calls per input, in one Node process.
 *   Every result feeds a running sum so the engine cannot drop the work.
 *
 *   Run it on a host with no CI run in progress, because busy runners slow it two to three times.
 *
 *   The tool lives in this package and not beside the `recognizer` benchmark because it
 *   imports `@mailwoman/postcode`, and `@mailwoman/recognizer` mustn't import that package.
 *
 *   Usage: `node packages/postcode/tools/bench.run.ts [--json]`
 */

import { readLocalBuffer } from "@mailwoman/core/fs/readers"
import { gitHead } from "@mailwoman/core/git"
import { prettyJSON } from "@mailwoman/core/json"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { cpuModel } from "@mailwoman/core/utils/system"
import { createRecognizer } from "@mailwoman/recognizer"
import { coordinates } from "@mailwoman/recognizer/coordinates"
import { defineFamily } from "@mailwoman/recognizer/family"
import { identifiers } from "@mailwoman/recognizer/identifiers"
import { primitives } from "@mailwoman/recognizer/primitives"
import { spatial } from "@mailwoman/recognizer/spatial"
import { structure } from "@mailwoman/recognizer/structure"

import { postcodeLegacy } from "#recognizer/legacy"
import { postal } from "#recognizer/postal"

const WARM_UP_CALLS = 20_000
const TIMED_CALLS = 200_000
const LABEL_MAX_UNITS = 80

const WHITE_HOUSE = "1600 Pennsylvania Avenue NW, Washington, DC 20500, United States of America"

/**
 * The inputs of the `recognizer` benchmark, the issue's timing table.
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

const { values } = parseArguments({
	options: { json: { type: "boolean", default: false }, "postal-artifact": { type: "string" } },
})

// `--postal-artifact <file>` times the postal family from another build of its artifact,
// such as one compiled to the other backend.
// The declarations hash is the same, so the engine loads it as the same family.
const otherArtifact = values["postal-artifact"] ? await readLocalBuffer(values["postal-artifact"]) : null
const postalFamily = otherArtifact ? defineFamily({ ...postal, artifact: () => otherArtifact }) : postal

const recognizer = createRecognizer([structure, postcodeLegacy, primitives, coordinates])
const withPostal = createRecognizer([structure, postcodeLegacy, postalFamily, primitives, coordinates])

// The same composition and the `spatial` and `identifiers` families.
// They add the plus code, DIGIPIN, GeoJSON, H3, geohash, Who's On First, GEOID
// and GNIS shapes to the search.
const withSpatial = createRecognizer([structure, postcodeLegacy, primitives, coordinates, spatial, identifiers])

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
	const adapter = microsecondsPerCall(input, (text) => recognizer.recognize(text).fields.knownFormats.length)

	const postalCall = microsecondsPerCall(input, (text) => {
		const result = withPostal.recognize(text)

		return result.fields.knownFormats.length + result.recognitions.length
	})

	const spatialCall = microsecondsPerCall(input, (text) => {
		const result = withSpatial.recognize(text)

		return result.fields.knownFormats.length + result.recognitions.length
	})

	return {
		spatialRecognizeMicroseconds: spatialCall.microseconds,
		postalRecognizeMicroseconds: postalCall.microseconds,
		postalCandidates: withPostal.recognize(input).recognitions.filter(({ kind }) => /^(postal|printed)\./u.test(kind))
			.length,
		input,
		utf16Units: input.length,
		utf8Bytes: encoder.encode(input).length,
		knownFormats: recognizer.recognize(input).fields.knownFormats.length,
		recognizeMicroseconds: adapter.microseconds,
		sink: adapter.sink + postalCall.sink + spatialCall.sink,
	}
})

const report = {
	commit: await gitHead(),
	node: process.version,
	cpu: cpuModel(),
	postalArtifact: values["postal-artifact"] ?? "committed",
	warmUpCalls: WARM_UP_CALLS,
	timedCalls: TIMED_CALLS,
	rows,
}

if (values.json) {
	console.log(prettyJSON(report))
} else {
	console.log(`commit ${report.commit}, node ${report.node}, ${report.cpu}`)
	console.log(`postal artifact: ${report.postalArtifact}`)
	console.log(`${WARM_UP_CALLS} warm-up calls, then ${TIMED_CALLS} timed calls per input\n`)
	console.log(
		"| Input | UTF-16 units | Known formats | Postal candidates | recognize without postal (µs/call) | recognize with postal (µs/call) | recognize with spatial and identifiers (µs/call) |"
	)
	console.log("| --- | --- | --- | --- | --- | --- | --- |")

	for (const row of rows) {
		const label = row.utf16Units > LABEL_MAX_UNITS ? `${row.input.slice(0, 40)}… (${row.utf16Units} units)` : row.input

		console.log(
			`| \`${label}\` | ${row.utf16Units} | ${row.knownFormats} | ${row.postalCandidates} | ${row.recognizeMicroseconds.toFixed(2)} | ${row.postalRecognizeMicroseconds.toFixed(2)} | ${row.spatialRecognizeMicroseconds.toFixed(2)} |`
		)
	}
}
