/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   What the host offers — cores, memory, platform — for sizing a fan-out or naming the machine in a report. The one
 *   place `node:os` is reached for it.
 */

import { arch, availableParallelism as nativeAvailableParallelism, cpus, platform, totalmem } from "node:os"

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
