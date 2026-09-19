/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Run one bounded child process and read its result off stdout — the coordination every chunked layer
 *   build uses to keep a polyfill's heap bounded.
 *
 *   the process boundary is the point and the caller'S reason rather than this function'S. h3's wasm
 *   heap cannot be reset from JavaScript and does not survive an unbounded number of polyfill calls, so a
 *   build gives each range a heap that starts empty by giving it an interpreter that starts empty. What
 *   lives here is only the plumbing that every such build repeats.
 *
 *   Stdout contains only the result. Progress is inherited — stderr passes straight
 *   through to the parent's — so a long chunk reports as it goes while stdout stays parseable without a
 *   framing convention. Only the last stdout line is read, so a child that prints diagnostics on stdout
 *   before its result still parses.
 *
 *   A NON-zero exit throws, and that is A correctness rule rather than A convenience. A chunk that died
 *   mid-range has already written part of its rows into the shared artifact. continuing would seal a
 *   database missing rows nobody could name, which reads downstream as a smaller source rather than as a
 *   failure. The same applies to a chunk that exits cleanly having printed nothing.
 */

import { TextSpliterator } from "spliterator"

import { parseJSONStrict } from "#json"
import { spawnProcess } from "#process"

export interface RunChunkProcessOptions {
	/**
	 * The script the child runs, as a filesystem path — resolve it with `import.meta.resolve` against the owning
	 * workspace's `scripts` subpath rather than assembling it.
	 */
	script: string
	args: readonly string[]
	/**
	 * Names the build in every refusal, e.g. `"flood build"`.
	 */
	context: string
	/**
	 * Names the range in the no-result refusal, e.g. `"chunk objectid 1–1000"`. A build whose ranges are identifiable
	 * should pass one: it is the difference between knowing which rows are unaccounted for and knowing only that some
	 * are. Defaults to `"a chunk"` for a build whose chunks have no natural name.
	 */
	subject?: string
}

/**
 * The argv every layer ingest-chunk process shares: the temp artifact the parent created, the caller's own flags, then
 * the two resolutions.
 *
 * The parent holds no handle while the chunks run — its caller closed one before the batched ingest and opens another
 * after. Each child opens the same file and appends. chunks run one at a time, so there is exactly one writer at every
 * instant and no locking to reason about. A chunk that exits non-zero, or prints no result line, throws in
 * {@link runChunkProcess}: a chunk that died mid-range has written a partial set of rows, and continuing would seal an
 * artifact missing features nobody could name.
 */
export function ingestChunkArguments(options: {
	database: string
	args?: readonly string[]
	indexResolution: number
	coverageResolution: number
}): string[] {
	return [
		"--database",
		options.database,
		...(options.args ?? []),
		"--index-resolution",
		String(options.indexResolution),
		"--coverage-resolution",
		String(options.coverageResolution),
	]
}

/**
 * Run one chunk process and parse its result line.
 *
 * @throws {Error} When the process fails to spawn, exits non-zero, or prints no result line.
 */
export async function runChunkProcess<T>(options: RunChunkProcessOptions): Promise<T> {
	const stdout = await new Promise<string>((resolve, reject) => {
		const child = spawnProcess(process.execPath, [options.script, ...options.args], {
			stdio: ["ignore", "pipe", "inherit"],
		})

		const parts: string[] = []

		child.stdout.setEncoding("utf8")

		child.stdout.on("data", (chunk: string) => {
			parts.push(chunk)
		})

		child.on("error", reject)

		child.on("close", (code) => {
			if (code === 0) {
				resolve(parts.join(""))

				return
			}

			reject(new Error(`${options.context}: chunk process exited ${code}`))
		})
	})

	const line = TextSpliterator.from(stdout.trim(), { delimiter: "\n" }).toArray().at(-1)

	if (!line) {
		throw new Error(
			`${options.context}: ${options.subject ?? "a chunk"} printed no result — its rows are in the artifact unaccounted for`
		)
	}

	return parseJSONStrict<T>(line)
}
