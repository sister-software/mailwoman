/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   One chunk of the zoning ingest, as its own process — spawned by `buildZoningDatabase`, never run by hand.
 *
 *   THE PROCESS BOUNDARY IS THE POINT. h3's WASM heap cannot be reset from JavaScript and does not survive an
 *   unbounded number of polyfill calls, so each chunk gets a heap that starts empty by getting an interpreter
 *   that starts empty. Everything else here is plumbing: parse a range, append to the database the parent
 *   created, and report counts on stdout as one JSON line.
 *
 *   STDOUT IS THE RESULT CHANNEL AND CARRIES NOTHING ELSE. Progress goes to stderr, so the parent can parse
 *   the last stdout line without a framing convention.
 */

import { DatabaseSync } from "@mailwoman/platform/sqlite"
import { parseArgs } from "@mailwoman/platform/util"
import { DatabaseClient } from "@mailwoman/sqlite/client"

import type { ZoningDatabase } from "../schema.ts"
import { ingestZoningChunk } from "../sdk/ingest-chunk.ts"
import { createExportFeatureSource } from "../sdk/ingest.ts"

const { values } = parseArgs({
	options: {
		database: { type: "string" },
		export: { type: "string" },
		"object-id-from": { type: "string" },
		"object-id-to": { type: "string" },
		"index-resolution": { type: "string" },
		"coverage-resolution": { type: "string" },
	},
})

function required(name: string, value: string | undefined): string {
	if (value === undefined) throw new Error(`zoning ingest-chunk: --${name} is required`)

	return value
}

const database = new DatabaseClient<ZoningDatabase>(required("database", values.database))

try {
	database.exec("PRAGMA journal_mode = OFF")
	database.exec("PRAGMA synchronous = OFF")

	const result = await ingestZoningChunk(database, {
		source: await createExportFeatureSource({
			exportPath: required("export", values.export),
			...(values["object-id-from"] === undefined ? {} : { objectIDFrom: Number(values["object-id-from"]) }),
			...(values["object-id-to"] === undefined ? {} : { objectIDTo: Number(values["object-id-to"]) }),
			// A RANGE's own count is not knowable up front — the source reports a layer's total and nothing narrower — so the
			// chunk asserts nothing about its size and the PARENT checks the sum against the whole file.
			declaredFeatureCount: 0,
		}),
		indexResolution: Number(required("index-resolution", values["index-resolution"])),
		coverageResolution: Number(required("coverage-resolution", values["coverage-resolution"])),
		onProgress: (message) => console.error(`  [chunk] ${message}`),
	})

	console.log(JSON.stringify(result))
} finally {
	database.destroy()
}
