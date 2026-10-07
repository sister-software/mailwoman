/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   One chunk of the zoning ingest, as its own process — spawned by `buildZoningDatabase`, never run by hand.
 */

import { requiredArgument } from "@mailwoman/core/scripting/arguments"
import { INGEST_CHUNK_FLAGS, runIngestChunkScript } from "@mailwoman/core/scripting/ingest-chunk-script"
import type { DatabaseClient } from "@mailwoman/sqlite/client"

import type { ZoningDatabase } from "#schema"
import { createExportFeatureSource } from "#sdk/ingest"
import { ingestZoningChunk } from "#sdk/ingest/chunk"

await runIngestChunkScript({
	context: "zoning ingest-chunk",
	options: {
		...INGEST_CHUNK_FLAGS,
		export: { type: "string" },
		"object-id-from": { type: "string" },
		"object-id-to": { type: "string" },
	},
	run: async (database: DatabaseClient<ZoningDatabase>, values, chunk) =>
		ingestZoningChunk(database, {
			source: await createExportFeatureSource({
				exportPath: requiredArgument("zoning ingest-chunk", "export", values.export ?? null),
				...(values["object-id-from"] === undefined ? {} : { objectIDFrom: Number(values["object-id-from"]) }),
				...(values["object-id-to"] === undefined ? {} : { objectIDTo: Number(values["object-id-to"]) }),
				// A range's count is not knowable up front: the source reports only the layer total,
				// so the parent checks the sum against the whole file.
				declaredFeatureCount: 0,
			}),
			indexResolution: chunk.indexResolution,
			coverageResolution: chunk.coverageResolution,
			onProgress: chunk.onProgress,
		}),
})
