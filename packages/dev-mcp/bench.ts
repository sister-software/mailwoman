/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Latency and throughput, with cold and warm kept apart.
 *
 *   A warm daemon makes it very easy to publish a throughput number no user will ever see. The measured gap on this box
 *   is not subtle — ~1.37 s of fixed cost before a cold process answers at all, against ~115 ms per query once warm —
 *   so a figure that quietly averages the two describes a system nobody runs. Cold and warm are therefore separate
 *   fields, always, and `cold: null` means the caller did not ask for it rather than that it was free.
 *
 *   Concurrency is fixed at 1 and says so. `session.run()` in `onnxruntime-node` blocks the thread it is on, and
 *   `geocode-stream.ts` records the measurement that settles the rest: on a shared multi-GB WOF SQLite, throughput
 *   peaked at 2 workers (~1.4×) and DEGRADED beyond, because memory bandwidth and the shared database are the ceiling.
 *   A single-threaded number is the honest one to quote.
 */

import { percentile } from "@mailwoman/core/utils"

export interface LatencyReading {
	n: number
	/**
	 * Nearest-rank percentiles. `percentile` takes `p` in **[0, 100]**, not a fraction — AGENTS.md flags the unit because
	 * local copies elsewhere took a fraction, and a careless swap silently changes the number by orders of magnitude.
	 */
	p50_ms: number | null
	p90_ms: number | null
	p99_ms: number | null
	max_ms: number | null
	mean_ms: number | null
	/**
	 * Derived from the MEAN rather than from the wall clock, so a run whose samples were interleaved with anything else
	 * reports the per-call rate rather than a figure the surrounding work inflated.
	 */
	throughput_per_s: number | null
}

export function summarizeLatency(samplesMs: number[]): LatencyReading {
	if (!samplesMs.length) {
		return { n: 0, p50_ms: null, p90_ms: null, p99_ms: null, max_ms: null, mean_ms: null, throughput_per_s: null }
	}

	const mean = samplesMs.reduce((total, value) => total + value, 0) / samplesMs.length

	return {
		n: samplesMs.length,
		p50_ms: percentile(samplesMs, 50),
		p90_ms: percentile(samplesMs, 90),
		p99_ms: percentile(samplesMs, 99),
		max_ms: Math.max(...samplesMs),
		mean_ms: mean,
		throughput_per_s: mean > 0 ? 1000 / mean : null,
	}
}

export interface BenchReading {
	/**
	 * The one-time construction cost, or `null` when the caller did not ask for it. Never zero — a cold start that was
	 * not measured is not a cold start that was free.
	 */
	cold: { engine_build_ms: number; first_query_ms: number; total_ms: number } | null
	warm: LatencyReading
	concurrency: 1
	note: string
	summary: string
}

/**
 * Why every benchmark here is single-threaded, carried on the result rather than left to a reader to know.
 *
 * Two measurements, not a preference: `session.run()` in `onnxruntime-node` blocks its calling thread, and
 * `geocode-stream.ts` recorded throughput on a shared multi-GB WOF SQLite peaking at 2 workers (~1.4x) and degrading
 * beyond it.
 */
export const CONCURRENCY_NOTE =
	"Single-threaded, and deliberately: session.run() in onnxruntime-node blocks the calling thread, and " +
	"geocode-stream.ts measured throughput on a shared multi-GB WOF SQLite peaking at 2 workers (~1.4×) and degrading " +
	"beyond — memory bandwidth and the shared database are the ceiling, not core count."

/**
 * Assemble the reading, with the sentence a caller will relay.
 *
 * The summary states the cold cost first when it was measured, because that is the number a user experiences and the
 * one a warm benchmark is most likely to leave out.
 */
export function assembleBench(cold: BenchReading["cold"], warm: LatencyReading): BenchReading {
	const warmPart =
		warm.n > 0
			? `Warm: p50 ${warm.p50_ms!.toFixed(1)}ms, p90 ${warm.p90_ms!.toFixed(1)}ms, p99 ${warm.p99_ms!.toFixed(1)}ms over ${warm.n} calls (${warm.throughput_per_s!.toFixed(1)}/s single-threaded).`
			: "No warm samples were taken."

	const coldPart = cold
		? `Cold: ${cold.total_ms}ms to first answer, of which ${cold.engine_build_ms}ms was engine construction.`
		: "Cold start NOT measured — this run says nothing about what a user's first query costs."

	return { cold, warm, concurrency: 1, note: CONCURRENCY_NOTE, summary: `${coldPart} ${warmPart}` }
}
