/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   One chunk of the coastal ingest, as its own process — spawned by `buildCoastalDatabase`, never run by
 *   hand. The process boundary and the stdout contract live with `runIngestChunkScript`; what stays here is
 *   only this product's flags and its feature-source constructor.
 */

import { requiredArgument } from "@mailwoman/core/scripting/arguments"
import { INGEST_CHUNK_FLAGS, runIngestChunkScript } from "@mailwoman/core/scripting/ingest-chunk-script"
import type { DatabaseClient } from "@mailwoman/sqlite/client"

import type { CoastalDatabase } from "#schema"
import { createGeodatabaseFeatureSource } from "#sdk/ingest"
import { ingestCoastalChunk } from "#sdk/ingest-chunk"

await runIngestChunkScript({
	context: "coastal ingest-chunk",
	options: {
		...INGEST_CHUNK_FLAGS,
		gdb: { type: "string" },
		scenario: { type: "string" },
		instability: { type: "boolean", default: false },
		"object-id-from": { type: "string" },
		"object-id-to": { type: "string" },
	},
	run: async (database: DatabaseClient<CoastalDatabase>, values, chunk) =>
		ingestCoastalChunk(database, {
			source: await createGeodatabaseFeatureSource({
				geodatabasePath: requiredArgument("coastal ingest-chunk", "gdb", values.gdb),
				// A chunk reads ONE layer family: either one scenario's erosion zones, or the two ground-instability layers.
				// Mixing them in one process would put the two hazards on one heap for no gain and would make the range bound
				// mean two different things at once.
				scenarioKeys: values.instability ? [] : [requiredArgument("coastal ingest-chunk", "scenario", values.scenario)],
				skipInstability: !values.instability,
				...(values["object-id-from"] === undefined ? {} : { objectIDFrom: Number(values["object-id-from"]) }),
				...(values["object-id-to"] === undefined ? {} : { objectIDTo: Number(values["object-id-to"]) }),
				// A RANGE's own count is not knowable up front — `ogrinfo` reports a layer's total and nothing narrower — so
				// the chunk asserts nothing about its size and the PARENT checks the sum against the whole file.
				declaredFeatureCount: 0,
			}),
			indexResolution: chunk.indexResolution,
			coverageResolution: chunk.coverageResolution,
			onProgress: chunk.onProgress,
		}),
})
