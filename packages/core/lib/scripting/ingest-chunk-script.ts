/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The plumbing every layer's `scripts/ingest-chunk.ts` repeats — spawned by its builder, never run by
 *   hand.
 *
 *   THE PROCESS BOUNDARY IS THE CALLER'S POINT. h3's WASM heap cannot be reset from JavaScript and does not
 *   survive an unbounded number of polyfill calls, so each chunk gets a heap that starts empty by getting an
 *   interpreter that starts empty. What lives here is only the plumbing: parse the shared flags, open the
 *   database the parent created with the build pragmas, run the chunk, and report its counts on stdout as
 *   one JSON line.
 *
 *   STDOUT IS THE RESULT CHANNEL AND CARRIES NOTHING ELSE. Progress goes to stderr, so the parent can parse
 *   the last stdout line without a framing convention.
 */

import { DatabaseClient } from "@mailwoman/sqlite/client"

import { parseArguments, requiredArgument, type ParseArgsConfig } from "#scripting/arguments"

/**
 * The flags every ingest-chunk script shares. A script spreads these into its own `options`, so the helper can rely on
 * them being parsed while the script's values stay precisely typed.
 */
export const INGEST_CHUNK_FLAGS = {
	database: { type: "string" },
	"index-resolution": { type: "string" },
	"coverage-resolution": { type: "string" },
} as const satisfies ParseArgsConfig["options"]

/**
 * The shared values the helper resolves for the chunk.
 */
export interface IngestChunkScriptContext {
	indexResolution: number
	coverageResolution: number
	/**
	 * Reports to stderr, prefixed the way every chunk script did.
	 */
	onProgress: (message: string) => void
}

/**
 * Run one ingest-chunk script: parse its flags, open the parent's database with the build pragmas, run the chunk, and
 * print its JSON result line.
 */
export async function runIngestChunkScript<
	DB,
	const Options extends NonNullable<ParseArgsConfig["options"]> & typeof INGEST_CHUNK_FLAGS,
>(config: {
	/**
	 * Names the script in every refusal, e.g. `flood ingest-chunk`.
	 */
	context: string
	/**
	 * The script's own flags, INCLUDING a spread of {@link INGEST_CHUNK_FLAGS}.
	 */
	options: Options
	run: (
		database: DatabaseClient<DB>,
		values: ReturnType<typeof parseArguments<{ options: Options }>>["values"],
		chunk: IngestChunkScriptContext
	) => Promise<unknown>
}): Promise<void> {
	const { values } = parseArguments({ options: config.options })

	// A second, lenient parse over only the shared flags: the strict parse above is typed by the script's own generic
	// config, whose conditional value type does not resolve inside this generic body — while this one is concretely
	// typed, and non-strict parsing reads the known flags identically. Non-strict parsing widens every value to
	// `string | boolean`, so the string-typed flags are narrowed back before use.
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

	console.log(JSON.stringify(result))
}
