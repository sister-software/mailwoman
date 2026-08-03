/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Cached archive download + subprocess capture, shared by `fetch.ts` and `redistricting.ts`.
 *
 *   RAW `fetch` HERE IS DELIBERATE. `AGENTS.md` requires HTTP clients to extend or instantiate
 *   `APIClient`, and that rule is about API REQUESTS — small bodies, repeated calls, rate-limited
 *   hosts, where its pacing, bounded retry, response caching and `ResourceError` mapping all earn
 *   their keep. This is a multi-gigabyte file transfer streamed straight to disk. Response caching
 *   would be nonsense at that size, pacing has nothing to pace (one request), and axios buffers a
 *   non-stream response type in memory. The primitive that fits a body this large is the one that
 *   never holds it: a web stream piped to a write stream.
 */

import { spawn } from "node:child_process"
import { createWriteStream, existsSync } from "node:fs"
import { rename } from "node:fs/promises"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"

/**
 * Run a command and resolve its stdout, rejecting with the captured stderr on a non-zero exit.
 *
 * Used for the `unzip -tq` integrity probe below — a shelled-out check rather than a library one because the archives
 * are large and `unzip -t` streams them without materializing the contents.
 */
export function runCapture(cmd: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(cmd, args)
		let out = ""
		let err = ""
		child.stdout.on("data", (d) => (out += d))
		child.stderr.on("data", (d) => (err += d))
		child.on("error", reject)

		child.on("close", (code) =>
			code === 0 ? resolve(out) : reject(new Error(`${cmd} exited ${code}: ${err.slice(0, 500)}`))
		)
	})
}

/**
 * Download `url` to `dest` unless a VALID copy is already there. Returns `true` when the cache was reused, `false` when
 * a download happened.
 *
 * "Valid" means `unzip -tq` passes — an existence check alone is not enough, because an interrupted download leaves a
 * plausible-looking file that fails only much later, inside ogr2ogr. Writes to a `.tmp` sibling and renames, so `dest`
 * is never a partial archive.
 */
export async function downloadIfNeeded(url: string, dest: string): Promise<boolean> {
	if (existsSync(dest)) {
		try {
			await runCapture("unzip", ["-tq", dest])

			return true
		} catch {
			// corrupt cache — re-download
		}
	}

	const tmp = dest + ".tmp"
	const res = await fetch(url, { redirect: "follow" })

	if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} fetching ${url}`)
	await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(tmp))
	await rename(tmp, dest)

	return false
}
