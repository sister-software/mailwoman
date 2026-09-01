/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   One chunk of the flood ingest, as its own process — spawned by `buildFloodDatabase`, never run by
 *   hand. The process boundary and the stdout contract live with `runIngestChunkScript`; what stays here
 *   is only this product's flags and its feature-source constructor.
 */

import { requiredArgument } from "@mailwoman/core/scripting/arguments"
import { INGEST_CHUNK_FLAGS, runIngestChunkScript } from "@mailwoman/core/scripting/ingest-chunk-script"
import type { DatabaseClient } from "@mailwoman/sqlite/client"

import type { FloodDatabase } from "#schema"
import { createGeodatabaseFeatureSource } from "#sdk/ingest"
import { ingestFloodChunk } from "#sdk/ingest-chunk"

await runIngestChunkScript({
	context: "flood ingest-chunk",
	options: {
		...INGEST_CHUNK_FLAGS,
		gdb: { type: "string" },
		layer: { type: "string" },
		"object-id-from": { type: "string" },
		"object-id-to": { type: "string" },
		"declared-feature-count": { type: "string" },
	},
	run: async (database: DatabaseClient<FloodDatabase>, values, chunk) =>
		ingestFloodChunk(database, {
			source: await createGeodatabaseFeatureSource({
				geodatabasePath: requiredArgument("flood ingest-chunk", "gdb", values.gdb),
				...(values.layer ? { layer: values.layer } : {}),
				objectIDFrom: Number(requiredArgument("flood ingest-chunk", "object-id-from", values["object-id-from"])),
				objectIDTo: Number(requiredArgument("flood ingest-chunk", "object-id-to", values["object-id-to"])),
				declaredFeatureCount: Number(
					requiredArgument("flood ingest-chunk", "declared-feature-count", values["declared-feature-count"])
				),
			}),
			indexResolution: chunk.indexResolution,
			coverageResolution: chunk.coverageResolution,
			onProgress: chunk.onProgress,
		}),
})
