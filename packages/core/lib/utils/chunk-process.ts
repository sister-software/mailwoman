/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Run one bounded child process and read its result off stdout — the coordination every chunked layer build uses
 *   to keep a polyfill's heap bounded: h3's wasm heap cannot be reset from JavaScript and does not survive an
 *   unbounded number of polyfill calls, so the process boundary gives each range an interpreter that starts empty.
 *
 *   Stdout contains only the result, stderr is inherited so progress passes straight through, and only the last
 *   stdout line is read, so a child that prints diagnostics before its result still parses.
 *
 *   A non-zero exit throws, and so does a chunk that exits cleanly having printed no rows: a chunk that died
 *   mid-range has already written part of its rows into the shared artifact, and continuing would seal a database
 *   missing rows nobody could name, which reads downstream as a smaller source rather than as a failure.
 */

import { TextSpliterator } from "spliterator"

import { parseJSONStrict } from "#json"
import { spawnProcess } from "#process"

export interface RunChunkProcessOptions {
	/**
	 * The script the child runs as a filesystem path, resolved with `import.meta.resolve`
	 * against the owning workspace's `scripts` subpath rather than assembled.
	 */
	script: string
	args: readonly string[]
	/**
	 * Names the build in every refusal, e.g. `"flood build"`.
	 */
	context: string
	/**
	 * Names the range in the no-result refusal, e.g. `"chunk objectid 1–1000"`, defaulting to
	 * `"a chunk"`; a build whose ranges are identifiable should pass one, because it is the
	 * difference between knowing which rows are unaccounted for and knowing only that some are.
	 */
	subject?: string
}

/**
 * The shared argv for a layer ingest chunk — the temp artifact, the caller's own flags,
 * then the two resolutions — where each child opens the same file and appends and chunks run one
 * at a time, so there is exactly one writer at every instant and no locking to reason about.
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
