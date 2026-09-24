/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Shared setup for each layer's `scripts/ingest-chunk.ts`.
 *
 *   Each chunk runs in a new process because h3's WebAssembly heap cannot be reset from JavaScript.
 *   This helper parses shared flags, opens the database created by the parent, runs the chunk,
 *   and prints its result as one JSON line.
 *
 *   Standard output contains only the result.
 *   Progress goes to standard error.
 */

import { DatabaseClient } from "@mailwoman/sqlite/client"

import { stringifyJSON } from "#json"
import { parseArguments, requiredArgument, type ParseArgsConfig } from "#scripting/arguments"

/**
 * Flags shared by all ingest-chunk scripts.
 *
 * Each script includes these in its options so this helper can read them
 * alongside the script's typed values.
 */
export const INGEST_CHUNK_FLAGS = {
	database: { type: "string" },
	"index-resolution": { type: "string" },
	"coverage-resolution": { type: "string" },
} as const satisfies ParseArgsConfig["options"]

/**
 * Shared settings passed to a chunk.
 */
export interface IngestChunkScriptContext {
	indexResolution: number
	coverageResolution: number
	/**
	 * Writes progress to stderr with the shared chunk prefix.
	 */
	onProgress: (message: string) => void
}

/**
 * Parse flags, open the parent's database, run one chunk, and print its JSON result.
 */
export async function runIngestChunkScript<
	DB,
	const Options extends NonNullable<ParseArgsConfig["options"]> & typeof INGEST_CHUNK_FLAGS,
>(config: {
	/**
	 * Script name used in error messages, e.g. `flood ingest-chunk`.
	 */
	context: string
	/**
	 * The script's flags, including {@link INGEST_CHUNK_FLAGS}.
	 */
	options: Options
	run: (
		database: DatabaseClient<DB>,
		values: ReturnType<typeof parseArguments<{ options: Options }>>["values"],
		chunk: IngestChunkScriptContext
	) => Promise<unknown>
}): Promise<void> {
	const { values } = parseArguments({ options: config.options })

	// Parse shared flags separately because the generic values above are not concrete inside this function.
	// Narrow the lenient parse's values to strings.
	const { values: shared } = parseArguments({ options: INGEST_CHUNK_FLAGS, strict: false })

	const sharedFlag = (name: keyof typeof INGEST_CHUNK_FLAGS): string =>
		requiredArgument(config.context, name, typeof shared[name] === "string" ? shared[name] : undefined)

	using database = new DatabaseClient<DB>(sharedFlag("database"))

	database.exec("PRAGMA journal_mode = OFF")
	database.exec("PRAGMA synchronous = OFF")

	const result = await config.run(database, values, {
		indexResolution: Number(sharedFlag("index-resolution")),
		coverageResolution: Number(sharedFlag("coverage-resolution")),
		onProgress: (message) => console.error(`  [chunk] ${message}`),
	})

	console.log(stringifyJSON(result))
}
