/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Parses every row of a suite rows file with one model on a pool of worker threads and writes one `{id, spans}`
 *   line per row. The file is written beside its destination and moved into place once every row is parsed, so an
 *   interrupted run leaves no partial parse file under the cached name.
 */

import { finished, openWriteStream } from "@mailwoman/core/fs/streams"
import { movePath } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/json"
import { JSONSpliterator, parallelMapWorkers } from "spliterator"

import type { BatterySpan } from "#tools/eval-harness/battery/classify"

const PARSE_WORKER_URL = new URL(import.meta.url.endsWith(".ts") ? "./worker.ts" : "./worker.js", import.meta.url)

export interface BatteryParseOptions {
	/**
	 * The package-shaped weights cache the arm's classifiers load from.
	 */
	cacheRoot: string
	workers: number
	/**
	 * ONNX intra-op threads per worker.
	 */
	threads: number
}

/**
 * Parses `rowsPath` with one arm and writes the parse file to `outPath`.
 *
 * @throws When fewer rows were parsed than the rows file holds.
 */
export async function parseBatteryRows(rowsPath: string, outPath: string, options: BatteryParseOptions): Promise<void> {
	const rows = await Array.fromAsync(
		JSONSpliterator.fromAsync<{ source_id: string; raw: string; country: string | null }>(rowsPath)
	)

	const partial = `${outPath}.partial`
	const out = openWriteStream(partial)
	const started = performance.now()
	let done = 0

	console.error(
		`${rows.length} rows, ${options.workers} workers × ${options.threads} ONNX threads, ${options.cacheRoot}`
	)

	for await (const result of parallelMapWorkers<
		{ source_id: string; raw: string; country: string | null },
		{ id: string; spans: BatterySpan[] }
	>(rows, {
		worker: PARSE_WORKER_URL,
		concurrency: options.workers,
		batchSize: 32,
		workerData: { cacheRoot: options.cacheRoot, intraOpNumThreads: options.threads },
	})) {
		out.write(`${stringifyJSON(result)}\n`)

		done++

		if (done % 5000 === 0 || done === rows.length) {
			const seconds = (performance.now() - started) / 1000

			console.error(`${done}/${rows.length} rows, ${(done / seconds).toFixed(0)} rows/s`)
		}
	}

	out.end()
	await finished(out)

	if (done !== rows.length) throw new Error(`parsed ${done} of ${rows.length} rows of ${rowsPath}`)

	await movePath(partial, outPath)
}
