/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Reads the host's cores, memory and platform to size a fan-out or name the machine in a report.
 *   This is the only module that reads those values from `node:os` or the heap ceiling from `node:v8`.
 */

import { arch, availableParallelism as nativeAvailableParallelism, cpus, platform, totalmem } from "node:os"
import { getHeapStatistics } from "node:v8"

/**
 * How many threads can run at once, as the runtime measures it — the ceiling for a worker pool.
 */
export function availableParallelism(): number {
	return nativeAvailableParallelism()
}

/**
 * The number of logical CPUs the host reports.
 */
export function cpuCount(): number {
	return cpus().length
}

/**
 * The model name of the first CPU, as the host reports it, or `"unknown CPU"` when it reports none.
 */
export function cpuModel(): string {
	return cpus()[0]?.model.trim() ?? "unknown CPU"
}

/**
 * Total system memory, in bytes.
 */
export function totalMemoryBytes(): number {
	return totalmem()
}

/**
 * The ceiling V8 will grow the old generation to, in bytes.
 *
 * This is what `--max-old-space-size` sets, defaulting to about 4 GiB.
 * A process that exceeds it aborts with SIGABRT rather than throwing, so a job whose peak memory is a
 * property of its input reads this at startup and refuses the run instead of failing partway through.
 */
export function heapLimitBytes(): number {
	return getHeapStatistics().heap_size_limit
}

/**
 * The operating system platform, as `node:os` names it (`linux`, `darwin`, `win32`).
 */
export function platformName(): string {
	return platform()
}

/**
 * The CPU architecture, as `node:os` names it (`x64`, `arm64`).
 */
export function architecture(): string {
	return arch()
}
