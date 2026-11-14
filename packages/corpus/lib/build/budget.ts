// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file The memory a parallel corpus build reserves for each worker process, and the host budget that bounds `--jobs`.
 *
 *   Each worker runs with an explicit JavaScript heap ceiling and an explicit DuckDB memory limit and thread count,
 *   because neither is bounded otherwise: Node's default heap is about 4 GiB, and DuckDB allocates outside the heap
 *   at a quarter of host memory per instance (`DUCKDB_MEMORY_SHARE`). A worker's reservation is the sum of its two
 *   ceilings plus an allowance for the process's other native allocations: buffers, the module graph and stream
 *   chunks. The scheduler admits a worker only while the running workers' reservations fit in the budget.
 *
 *   The reservations are ceilings rather than measurements. The 2026-10-20 profile measured 2.10 GiB peak RSS in the
 *   adapter phase, 0.48 GiB in align and 4.39 GiB in the parquet phase of a serial build holding every source.
 */

import { availableParallelism, totalMemoryBytes } from "@mailwoman/core/utils/system"

const GiB = 1024 ** 3

/**
 * The resources one worker process runs with.
 */
export interface WorkerResources {
	/**
	 * `--max-old-space-size`, in bytes.
	 */
	heapBytes: number
	/**
	 * DuckDB's `memory_limit`, in bytes, or 0 for a worker that opens no DuckDB instance.
	 */
	duckdbBytes: number
	/**
	 * DuckDB's `threads`.
	 *
	 * The parquet conversion uses `CONVERSION_THREADS` regardless of this value.
	 * A multi-threaded conversion produces different bytes across runs,
	 * so each worker uses one thread for all other DuckDB work.
	 */
	duckdbThreads: number
}

/**
 * The worker classes.
 *
 * `standard` runs every task: an adapter, an align range, or a source's sort and parquet write.
 * The WOF adapters read the WOF record store and peaked at 1,862 MiB
 * (`wof-admin`, 79,116,868 rows) and 636 MiB (`wof-postalcode`, 5,240,681 rows) by
 * kernel `maxRSS` over the lab's full clone set, inside the standard heap.
 */
export const WORKER_CLASSES = {
	standard: { heapBytes: 6 * GiB, duckdbBytes: 1.5 * GiB, duckdbThreads: 1 },
} as const satisfies Record<string, WorkerResources>

export type WorkerClass = keyof typeof WORKER_CLASSES

/**
 * Native memory a worker holds outside its heap and DuckDB: stream buffers, the module graph, `sort` pipes.
 */
export const WORKER_NATIVE_ALLOWANCE_BYTES = 0.5 * GiB

/**
 * Host memory the budget leaves out: 4 GiB for the operating system, the page cache floor
 * and the CI runners that share the lab host, plus 0.5 GiB for the coordinator.
 * The coordinator stores merged tallies and no rows.
 */
export const HOST_RESERVE_BYTES = 4.5 * GiB

/**
 * Bytes one worker of `workerClass` reserves while it runs.
 */
export function workerReservationBytes(workerClass: WorkerClass): number {
	const resources = WORKER_CLASSES[workerClass]

	return resources.heapBytes + resources.duckdbBytes + WORKER_NATIVE_ALLOWANCE_BYTES
}

/**
 * A parallel build's memory plan.
 */
export interface WorkerBudget {
	jobs: number
	hostMemoryBytes: number
	budgetBytes: number
}

const gib = (bytes: number): string => `${(bytes / GiB).toFixed(1)} GiB`

/**
 * The `--jobs` a build takes when none is given: the most standard workers the
 * host's budget holds, capped at the host's CPU count.
 *
 * Returns 1 for a serial build when fewer than two workers fit.
 */
export function defaultBuildJobs(opts: { hostMemoryBytes?: number } = {}): number {
	const hostMemoryBytes = opts.hostMemoryBytes ?? totalMemoryBytes()
	const budgetBytes = hostMemoryBytes - HOST_RESERVE_BYTES
	const fits = Math.min(availableParallelism(), Math.floor(budgetBytes / workerReservationBytes("standard")))

	return fits >= 2 ? fits : 1
}

/**
 * Check that `jobs` standard workers fit in the host budget.
 *
 * @throws When `jobs` standard workers exceed the budget.
 * The error lists each reservation and the largest `--jobs` that fits.
 */
export function planWorkerBudget(opts: { jobs: number; hostMemoryBytes?: number }): WorkerBudget {
	const hostMemoryBytes = opts.hostMemoryBytes ?? totalMemoryBytes()
	const budgetBytes = hostMemoryBytes - HOST_RESERVE_BYTES
	const standard = workerReservationBytes("standard")
	const fits = Math.max(0, Math.floor(budgetBytes / standard))

	const sizes =
		`each standard worker reserves ${gib(standard)} (heap ${gib(WORKER_CLASSES.standard.heapBytes)}, ` +
		`DuckDB ${gib(WORKER_CLASSES.standard.duckdbBytes)}, native ${gib(WORKER_NATIVE_ALLOWANCE_BYTES)}), ` +
		`and the budget is ${gib(hostMemoryBytes)} of host memory less ${gib(HOST_RESERVE_BYTES)} reserved, ${gib(budgetBytes)}`

	if (opts.jobs * standard > budgetBytes) {
		throw new Error(
			`corpus build refused: --jobs ${opts.jobs} needs ${gib(opts.jobs * standard)} and ${sizes}. ` +
				(fits >= 1 ? `--jobs ${fits} fits.` : "No parallel build fits this host; run with --jobs 1.")
		)
	}

	return { jobs: opts.jobs, hostMemoryBytes, budgetBytes }
}
