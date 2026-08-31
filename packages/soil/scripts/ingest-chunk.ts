/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   One chunk of the soil ingest, as its own process — spawned by `buildSoilDatabase`, never run by hand.
 *
 *   THE PROCESS BOUNDARY IS THE POINT. h3's WASM heap cannot be reset from JavaScript and does not survive
 *   an unbounded number of polyfill calls, so each chunk gets a heap that starts empty by getting an
 *   interpreter that starts empty. Everything else here is plumbing: parse a FID range, append to the
 *   database the parent created, and report counts on stdout as one JSON line.
 *
 *   STDOUT IS THE RESULT CHANNEL AND CARRIES NOTHING ELSE. Progress goes to stderr, so the parent can parse
 *   the last stdout line without a framing convention.
 */

import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { DatabaseClient } from "@mailwoman/sqlite/client"

import type { SoilDatabase } from "#schema"
import { createShapefileFeatureSource } from "#sdk/ingest"
import { ingestSoilChunk } from "#sdk/ingest-chunk"

const { values } = parseArguments({
	options: {
		database: { type: "string" },
		shapefile: { type: "string" },
		"area-symbol": { type: "string" },
		"fid-from": { type: "string" },
		"fid-to": { type: "string" },
		"index-resolution": { type: "string" },
		"coverage-resolution": { type: "string" },
		"no-mapping-mukeys": { type: "string" },
	},
})

function required(name: string, value: string | undefined): string {
	if (value === undefined) throw new Error(`soil ingest-chunk: --${name} is required`)

	return value
}

using database = new DatabaseClient<SoilDatabase>(required("database", values.database))

database.exec("PRAGMA journal_mode = OFF")
database.exec("PRAGMA synchronous = OFF")

const areaSymbol = required("area-symbol", values["area-symbol"])
const fidFrom = Number(required("fid-from", values["fid-from"]))
const fidTo = Number(required("fid-to", values["fid-to"]))

const result = await ingestSoilChunk(database, {
	source: await createShapefileFeatureSource({
		shapefilePath: required("shapefile", values.shapefile),
		areaSymbol,
		fidFrom,
		fidTo,
		// A range's own count is not knowable up front — `ogrinfo` reports the layer's total and nothing narrower — so
		// the chunk asserts nothing about its size and the PARENT checks the per-area sum against the shapefile's.
		declaredFeatureCount: 0,
	}),
	indexResolution: Number(required("index-resolution", values["index-resolution"])),
	coverageResolution: Number(required("coverage-resolution", values["coverage-resolution"])),
	// An empty string is an empty set, not "every map unit": a build where nothing lacks soil mapping passes one, and
	// `"".split(",")` yields one empty element that has to be dropped rather than joined against as a mukey.
	noMappingMukeys: new Set((values["no-mapping-mukeys"] ?? "").split(",").filter((mukey) => mukey.length > 0)),
	onProgress: (message) => console.error(`  [chunk] ${message}`),
})

console.log(JSON.stringify(result))
