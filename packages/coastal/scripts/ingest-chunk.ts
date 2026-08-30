/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   One chunk of the coastal ingest, as its own process — spawned by `buildCoastalDatabase`, never run by
 *   hand.
 *
 *   THE PROCESS BOUNDARY IS THE POINT. h3's WASM heap cannot be reset from JavaScript and does not survive an
 *   unbounded number of polyfill calls, so each chunk gets a heap that starts empty by getting an interpreter
 *   that starts empty. Everything else here is plumbing: parse a scenario and a range, append to the database
 *   the parent created, and report counts on stdout as one JSON line.
 *
 *   STDOUT IS THE RESULT CHANNEL AND CARRIES NOTHING ELSE. Progress goes to stderr, so the parent can parse
 *   the last stdout line without a framing convention.
 */

import { parseArgs } from "@mailwoman/platform/util"
import { DatabaseClient } from "@mailwoman/sqlite/client"

import type { CoastalDatabase } from "../schema.ts"
import { ingestCoastalChunk } from "../sdk/ingest-chunk.ts"
import { createGeodatabaseFeatureSource } from "../sdk/ingest.ts"

const { values } = parseArgs({
	options: {
		database: { type: "string" },
		gdb: { type: "string" },
		scenario: { type: "string" },
		instability: { type: "boolean", default: false },
		"object-id-from": { type: "string" },
		"object-id-to": { type: "string" },
		"index-resolution": { type: "string" },
		"coverage-resolution": { type: "string" },
	},
})

function required(name: string, value: string | undefined): string {
	if (value === undefined) throw new Error(`coastal ingest-chunk: --${name} is required`)

	return value
}

using database = new DatabaseClient<CoastalDatabase>(required("database", values.database))

database.exec("PRAGMA journal_mode = OFF")
database.exec("PRAGMA synchronous = OFF")

const result = await ingestCoastalChunk(database, {
	source: await createGeodatabaseFeatureSource({
		geodatabasePath: required("gdb", values.gdb),
		// A chunk reads ONE layer family: either one scenario's erosion zones, or the two ground-instability layers.
		// Mixing them in one process would put the two hazards on one heap for no gain and would make the range bound
		// mean two different things at once.
		scenarioKeys: values.instability ? [] : [required("scenario", values.scenario)],
		skipInstability: !values.instability,
		...(values["object-id-from"] === undefined ? {} : { objectIDFrom: Number(values["object-id-from"]) }),
		...(values["object-id-to"] === undefined ? {} : { objectIDTo: Number(values["object-id-to"]) }),
		// A RANGE's own count is not knowable up front — `ogrinfo` reports a layer's total and nothing narrower — so the
		// chunk asserts nothing about its size and the PARENT checks the sum against the whole file.
		declaredFeatureCount: 0,
	}),
	indexResolution: Number(required("index-resolution", values["index-resolution"])),
	coverageResolution: Number(required("coverage-resolution", values["coverage-resolution"])),
	onProgress: (message) => console.error(`  [chunk] ${message}`),
})

console.log(JSON.stringify(result))
