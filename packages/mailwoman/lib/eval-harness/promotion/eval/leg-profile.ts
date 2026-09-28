/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Per-leg wall time for one promotion run, written beside the run rather than into it.
 *
 *   The path must name somewhere outside the promotion output directory: `comparePromotionOutputs`
 *   reads every file under it byte-for-byte, and a wall time differs between two runs of the same
 *   artifact.
 */

import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"

export interface LegTiming {
	/**
	 * The leg's name, as the runbook and the output filenames spell it: `per-locale`,
	 * `affix`, `de-order`, `arena`.
	 */
	leg: string
	/**
	 * Which arm ran it — `fp32`, `int8`, or absent for a leg that runs once on the ship artifact.
	 */
	tag?: string
	wallMs: number
}

/**
 * Collects one entry per timed leg, in completion order, writing the ledger when the scope holding it ends.
 *
 * Hold it with `await using` so a battery that fails part way through still
 * writes what it collected before the throw.
 */
export class LegProfile implements AsyncDisposable {
	readonly #timings: LegTiming[] = []
	readonly #path: string

	/**
	 * @param path Where to write the ledger.
	 * An empty path writes none, and a non-empty one must sit outside the battery's output directory.
	 */
	constructor(path: string) {
		this.#path = path
	}

	/**
	 * Run `work`, record its wall time, and hand back whatever it returned.
	 *
	 * A leg that throws is still recorded, because the time it spent
	 * before failing is the number a reader wants.
	 */
	async time<T>(leg: string, tag: string | undefined, work: () => Promise<T>): Promise<T> {
		const startedAt = performance.now()

		try {
			return await work()
		} finally {
			this.#timings.push({ leg, ...(tag ? { tag } : {}), wallMs: Math.round(performance.now() - startedAt) })
		}
	}

	get timings(): readonly LegTiming[] {
		return this.#timings
	}

	/**
	 * Write the ledger, or skip the write when the path is empty; `total_ms` sums the legs
	 * and so is less than the run's wall clock.
	 */
	async [Symbol.asyncDispose](): Promise<void> {
		if (!this.#path) return

		await writeLocalJSONFile(
			{
				legs: this.#timings,
				total_ms: this.#timings.reduce((sum, timing) => sum + timing.wallMs, 0),
			},
			this.#path
		)
	}
}
