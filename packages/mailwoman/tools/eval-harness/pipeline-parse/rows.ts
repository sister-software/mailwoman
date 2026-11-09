/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Parses rows through the runtime pipeline on a pool of worker threads, one classifier and pipeline per thread,
 *   and returns each row's parse in input order.
 *
 *   The battery's pool (`battery/parse/rows.ts`) calls the bare classifier with the held-out inference options. This
 *   one calls `createRuntimePipeline`, the path a library caller and the CLI parse through, so a study of what
 *   production returns can run on every core.
 */

import { totalMemoryBytes } from "@mailwoman/core/utils/system"
import { parallelMapWorkers } from "spliterator"

import type {
	PipelineParse,
	PipelineParseRow,
	PipelineParseWorkerData,
} from "#tools/eval-harness/pipeline-parse/worker"

const WORKER_URL = new URL(import.meta.url.endsWith(".ts") ? "./worker.ts" : "./worker.js", import.meta.url)

/**
 * Peak resident memory one worker thread adds with the en-US classifier and pipeline loaded.
 *
 * Measured on the lab host, 2026-11-09: 0.62 GB for one worker and 4.41 GB for eight,
 * so about 0.46 GB per added worker (#2985).
 */
export const PIPELINE_WORKER_BYTES = 0.46e9

/**
 * The share of the host's memory a pool may claim, leaving room for the main thread and whatever else runs.
 */
const POOL_MEMORY_SHARE = 0.5

export interface PipelineParseOptions extends Partial<Omit<PipelineParseWorkerData, "intraOpNumThreads">> {
	/**
	 * Worker threads.
	 *
	 * @defaultValue 4
	 */
	workers?: number
	/**
	 * ONNX intra-op threads per worker.
	 *
	 * @defaultValue 1
	 */
	threads?: number
	/**
	 * Called with the number of rows parsed so far, every 5,000 rows and at the end.
	 */
	onProgress?: (parsed: number, total: number) => void
}

/**
 * One worker's share of a run: the rows it parsed and the time it spent parsing them.
 */
export interface PipelineWorkerThroughput {
	worker: number
	rows: number
	busyMs: number
	/**
	 * Rows per second of the worker's own parsing time.
	 */
	rowsPerSecond: number
}

/**
 * Totals each worker's rows and parsing time over a run's parses, ordered by worker `threadId`.
 */
export function workerThroughput(parses: readonly PipelineParse[]): PipelineWorkerThroughput[] {
	const byWorker = new Map<number, { rows: number; busyMs: number }>()

	for (const parse of parses) {
		const entry = byWorker.get(parse.worker) ?? { rows: 0, busyMs: 0 }

		entry.rows++
		entry.busyMs += parse.ms
		byWorker.set(parse.worker, entry)
	}

	return [...byWorker]
		.toSorted(([a], [b]) => a - b)
		.map(([worker, { rows, busyMs }]) => ({ worker, rows, busyMs, rowsPerSecond: busyMs ? (rows * 1000) / busyMs : 0 }))
}

/**
 * Parses `rows` and returns one parse per row, in the order the rows were given.
 *
 * @throws When `workers` would need more than half the host's memory, or when a row's parse never returns.
 */
export async function parsePipelineRows(
	rows: readonly PipelineParseRow[],
	options: PipelineParseOptions = {}
): Promise<PipelineParse[]> {
	const workers = options.workers ?? 4
	const needed = workers * PIPELINE_WORKER_BYTES
	const allowed = totalMemoryBytes() * POOL_MEMORY_SHARE

	if (needed > allowed) {
		throw new Error(
			`${workers} pipeline workers need about ${(needed / 1e9).toFixed(1)} GB, ` +
				`more than half of this host's ${(totalMemoryBytes() / 1e9).toFixed(1)} GB`
		)
	}

	const data: PipelineParseWorkerData = {
		locale: options.locale ?? "en-US",
		cacheRoot: options.cacheRoot ?? null,
		intraOpNumThreads: options.threads ?? 1,
		conventions: options.conventions ?? "declared",
	}

	const byID = new Map<string, PipelineParse>()

	for await (const parse of parallelMapWorkers<PipelineParseRow, PipelineParse>(rows, {
		worker: WORKER_URL,
		concurrency: workers,
		batchSize: 32,
		workerData: data,
	})) {
		byID.set(parse.id, parse)

		if (byID.size % 5000 === 0 || byID.size === rows.length) {
			options.onProgress?.(byID.size, rows.length)
		}
	}

	return rows.map((row) => {
		const parse = byID.get(row.id)

		if (!parse) throw new Error(`row ${row.id} returned no parse; ${byID.size} of ${rows.length} rows parsed`)

		return parse
	})
}
