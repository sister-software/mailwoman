/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
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

import { totalMemoryBytes } from "@mailwoman/core/utils/system"

import { isResidentRecordAdapter } from "#build/heap"

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
	 * The parquet conversion runs at `CONVERSION_THREADS` whatever this says, because a multi-threaded
	 * conversion's bytes vary between runs, so one thread is the whole of a worker's DuckDB work.
	 */
	duckdbThreads: number
}

/**
 * The two worker classes.
 *
 * `standard` runs every task except a resident-record adapter: an adapter,
 * an align range, or a source's sort and parquet write.
 * `resident` runs `wof-admin` or `wof-postalcode`, whose run holds every source record in memory
 * (`#build/heap`), with a 16 GiB heap above the 15 GiB floor `assertHeapForAdapters` enforces.
 */
export const WORKER_CLASSES = {
	standard: { heapBytes: 6 * GiB, duckdbBytes: 1.5 * GiB, duckdbThreads: 1 },
	resident: { heapBytes: 16 * GiB, duckdbBytes: 0, duckdbThreads: 1 },
} as const satisfies Record<string, WorkerResources>

export type WorkerClass = keyof typeof WORKER_CLASSES

/**
 * Native memory a worker holds outside its heap and DuckDB: stream buffers, the module graph, `sort` pipes.
 */
export const WORKER_NATIVE_ALLOWANCE_BYTES = 0.5 * GiB

/**
 * Host memory the budget leaves out: 4 GiB for the operating system, the page cache floor
 * and the CI runners that share the lab host, and 0.5 GiB for the coordinator,
 * which holds the merged tallies and no rows.
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
 * The class a source's adapter task runs in.
 */
export function adapterWorkerClass(adapterID: string): WorkerClass {
	return isResidentRecordAdapter(adapterID) ? "resident" : "standard"
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
 * Check that `jobs` standard workers fit in the host's budget, and that a resident adapter fits alone.
 *
 * A resident adapter runs one at a time and beside as many standard workers as still fit,
 * so it lowers the build's concurrency while it runs rather than raising its demand.
 *
 * @throws When `jobs` standard workers exceed the budget, or a configured resident adapter
 * exceeds it alone, naming each reservation and the largest `--jobs` that fits.
 */
export function planWorkerBudget(opts: {
	jobs: number
	adapterIDs: readonly string[]
	hostMemoryBytes?: number
}): WorkerBudget {
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

	const resident = opts.adapterIDs.filter(isResidentRecordAdapter)

	if (resident.length && workerReservationBytes("resident") > budgetBytes) {
		throw new Error(
			`corpus build refused: ${resident.join(", ")} ${resident.length === 1 ? "runs" : "run"} in a worker reserving ` +
				`${gib(workerReservationBytes("resident"))} (heap ${gib(WORKER_CLASSES.resident.heapBytes)}), and ${sizes}. ` +
				`Run with --jobs 1 on a host that can hold it, or leave ${resident.join(", ")} out of --inputs.`
		)
	}

	return { jobs: opts.jobs, hostMemoryBytes, budgetBytes }
}
