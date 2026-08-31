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

import { parseArguments, requiredArgument } from "@mailwoman/core/scripting/arguments"
import { DatabaseClient } from "@mailwoman/sqlite/client"

import type { ZoningDatabase } from "#schema"
import { createExportFeatureSource } from "#sdk/ingest"
import { ingestZoningChunk } from "#sdk/ingest-chunk"

const { values } = parseArguments({
	options: {
		database: { type: "string" },
		export: { type: "string" },
		"object-id-from": { type: "string" },
		"object-id-to": { type: "string" },
		"index-resolution": { type: "string" },
		"coverage-resolution": { type: "string" },
	},
})

using database = new DatabaseClient<ZoningDatabase>(
	requiredArgument("zoning ingest-chunk", "database", values.database)
)

database.exec("PRAGMA journal_mode = OFF")
database.exec("PRAGMA synchronous = OFF")

const result = await ingestZoningChunk(database, {
	source: await createExportFeatureSource({
		exportPath: requiredArgument("zoning ingest-chunk", "export", values.export),
		...(values["object-id-from"] === undefined ? {} : { objectIDFrom: Number(values["object-id-from"]) }),
		...(values["object-id-to"] === undefined ? {} : { objectIDTo: Number(values["object-id-to"]) }),
		// A RANGE's own count is not knowable up front — the source reports a layer's total and nothing narrower — so the
		// chunk asserts nothing about its size and the PARENT checks the sum against the whole file.
		declaredFeatureCount: 0,
	}),
	indexResolution: Number(requiredArgument("zoning ingest-chunk", "index-resolution", values["index-resolution"])),
	coverageResolution: Number(
		requiredArgument("zoning ingest-chunk", "coverage-resolution", values["coverage-resolution"])
	),
	onProgress: (message) => console.error(`  [chunk] ${message}`),
})

console.log(JSON.stringify(result))
