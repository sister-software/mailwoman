/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   One chunk of the soil ingest, as its own process — spawned by `buildSoilDatabase`, never run by hand.
 *   The process boundary and the stdout contract live with `runIngestChunkScript`; what stays here is only
 *   this product's flags and its feature-source constructor.
 */

import { requiredArgument } from "@mailwoman/core/scripting/arguments"
import { INGEST_CHUNK_FLAGS, runIngestChunkScript } from "@mailwoman/core/scripting/ingest-chunk-script"
import type { DatabaseClient } from "@mailwoman/sqlite/client"

import type { SoilDatabase } from "#schema"
import { createShapefileFeatureSource } from "#sdk/ingest"
import { ingestSoilChunk } from "#sdk/ingest-chunk"

await runIngestChunkScript({
	context: "soil ingest-chunk",
	options: {
		...INGEST_CHUNK_FLAGS,
		shapefile: { type: "string" },
		"area-symbol": { type: "string" },
		"fid-from": { type: "string" },
		"fid-to": { type: "string" },
		"no-mapping-mukeys": { type: "string" },
	},
	run: async (database: DatabaseClient<SoilDatabase>, values, chunk) =>
		ingestSoilChunk(database, {
			source: await createShapefileFeatureSource({
				shapefilePath: requiredArgument("soil ingest-chunk", "shapefile", values.shapefile),
				areaSymbol: requiredArgument("soil ingest-chunk", "area-symbol", values["area-symbol"]),
				fidFrom: Number(requiredArgument("soil ingest-chunk", "fid-from", values["fid-from"])),
				fidTo: Number(requiredArgument("soil ingest-chunk", "fid-to", values["fid-to"])),
				// A range's own count is not knowable up front — `ogrinfo` reports the layer's total and nothing narrower — so
				// the chunk asserts nothing about its size and the PARENT checks the per-area sum against the shapefile's.
				declaredFeatureCount: 0,
			}),
			indexResolution: chunk.indexResolution,
			coverageResolution: chunk.coverageResolution,
			// An empty string is an empty set, not "every map unit": a build where nothing lacks soil mapping passes one, and
			// `"".split(",")` yields one empty element that has to be dropped rather than joined against as a mukey.
			noMappingMukeys: new Set((values["no-mapping-mukeys"] ?? "").split(",").filter((mukey) => mukey.length > 0)),
			onProgress: chunk.onProgress,
		}),
})
