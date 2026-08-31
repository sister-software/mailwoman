/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   One chunk of the flood ingest, as its own process — spawned by `buildFloodDatabase`, never run by
 *   hand.
 *
 *   THE PROCESS BOUNDARY IS THE POINT. h3's WASM heap cannot be reset from JavaScript and does not
 *   survive an unbounded number of polyfill calls, so each chunk gets a heap that starts empty by
 *   getting an interpreter that starts empty. Everything else here is plumbing: parse a range, append to
 *   the database the parent created, and report counts on stdout as one JSON line.
 *
 *   STDOUT IS THE RESULT CHANNEL AND CARRIES NOTHING ELSE. Progress goes to stderr, so the parent can
 *   parse the last stdout line without a framing convention.
 */

import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { DatabaseClient } from "@mailwoman/sqlite/client"

import type { FloodDatabase } from "#schema"
import { createGeodatabaseFeatureSource } from "#sdk/ingest"
import { ingestFloodChunk } from "#sdk/ingest-chunk"

const { values } = parseArguments({
	options: {
		database: { type: "string" },
		gdb: { type: "string" },
		layer: { type: "string" },
		"object-id-from": { type: "string" },
		"object-id-to": { type: "string" },
		"declared-feature-count": { type: "string" },
		"index-resolution": { type: "string" },
		"coverage-resolution": { type: "string" },
	},
})

function required(name: string, value: string | undefined): string {
	if (value === undefined) throw new Error(`flood ingest-chunk: --${name} is required`)

	return value
}

using database = new DatabaseClient<FloodDatabase>(required("database", values.database))

database.exec("PRAGMA journal_mode = OFF")
database.exec("PRAGMA synchronous = OFF")

const result = await ingestFloodChunk(database, {
	source: await createGeodatabaseFeatureSource({
		geodatabasePath: required("gdb", values.gdb),
		...(values.layer ? { layer: values.layer } : {}),
		objectIDFrom: Number(required("object-id-from", values["object-id-from"])),
		objectIDTo: Number(required("object-id-to", values["object-id-to"])),
		declaredFeatureCount: Number(required("declared-feature-count", values["declared-feature-count"])),
	}),
	indexResolution: Number(required("index-resolution", values["index-resolution"])),
	coverageResolution: Number(required("coverage-resolution", values["coverage-resolution"])),
	onProgress: (message) => console.error(`  [chunk] ${message}`),
})

console.log(JSON.stringify(result))
