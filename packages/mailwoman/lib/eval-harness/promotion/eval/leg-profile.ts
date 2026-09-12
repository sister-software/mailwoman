/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Per-leg wall time for one promotion run, written beside the run rather than into it.
 *
 *   The battery's own log times one leg — per-locale prints `us.jsonl: n=2660 … in 50.9s`. Everything else is
 *   unattributed, so a question like "where do the nine minutes go" is answered by extrapolating row counts, which is
 *   how the de-order row count came to be wrong by 6,000 rows in an earlier triage.
 *
 *   The recorder writes nothing unless a path is given, and the path must name somewhere OUTSIDE the promotion output
 *   directory: `comparePromotionOutputs` reads every file under it byte-for-byte, and a wall time differs between two
 *   runs of the same artifact.
 */

import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"

export interface LegTiming {
	/**
	 * The leg's name, as the runbook and the output filenames spell it: `per-locale`, `affix`, `de-order`, `arena`.
	 */
	leg: string
	/**
	 * Which arm ran it — `fp32`, `int8`, or absent for a leg that runs once on the ship artifact.
	 */
	tag?: string
	wallMs: number
}

/**
 * Collects one entry per timed leg, in completion order, and writes the ledger when the scope holding it ends.
 *
 * Hold it with `await using`: a battery that fails part way through is exactly when the timings are worth reading, and
 * disposal writes what was collected before the throw rather than nothing.
 */
export class LegProfile implements AsyncDisposable {
	readonly #timings: LegTiming[] = []
	readonly #path: string

	/**
	 * @param path Where to write the ledger. An EMPTY path writes nothing, which is the default for every run that did
	 *   not ask to be profiled. A non-empty one must sit outside the battery's output directory — see the file header.
	 */
	constructor(path: string) {
		this.#path = path
	}

	/**
	 * Run `work`, record its wall time, and hand back whatever it returned. A leg that throws is still recorded, because
	 * the time it spent before failing is the number a reader is looking for.
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
	 * Write the ledger, or nothing when the path is empty. `total_ms` sums the legs, which is LESS than the run's wall
	 * clock: the untimed remainder is the verdict assembly, the spec read, and whatever else sits between legs.
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
