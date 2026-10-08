/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Generic in-process timing metrics over string-keyed tiers and a bounded recent-latency reservoir.
 */

import { percentileSorted } from "@mailwoman/core/stats"
import { z } from "zod"

/**
 * Recent-latency reservoir size, roughly 2k samples for a stable p99 within bounded memory.
 */
const MAX_SAMPLES = 2048

const latencies: number[] = []
let writeIdx = 0

/**
 * A null-prototype record whose tier keys are created lazily on first use.
 */
const tierCounts: Record<string, number> = Object.create(null)
let total = 0
let errors = 0
const startedAt = Date.now()

/**
 * Record one completed timed operation and its wall-clock latency, with the
 * reserved `"error"` tier counting toward errors.
 */
export function recordTimed(latencyMs: number, tier: string): void {
	total++

	if (tier === "error") {
		errors++
	} else {
		tierCounts[tier] = (tierCounts[tier] ?? 0) + 1
	}

	if (latencies.length < MAX_SAMPLES) {
		latencies.push(latencyMs)
	} else {
		latencies[writeIdx] = latencyMs
		writeIdx = (writeIdx + 1) % MAX_SAMPLES
	}
}

/**
 * A latency percentile in milliseconds with two decimals, where an empty sample is a caller error.
 */
function latencyPercentile(sorted: readonly number[], p: number): number {
	const value = percentileSorted(sorted, p)

	if (value === null) throw new Error("latencyPercentile requires a non-empty sample")

	return Math.round(value * 100) / 100
}

/**
 * The in-process timing metrics: latency percentiles and per-tier counts.
 */
export const MetricsSnapshotSchema = z
	.object({
		uptime_s: z.number(),
		timings: z.object({
			total: z.number(),
			errors: z.number(),
			/**
			 * Per-tier counts, absent for a tier that was never recorded.
			 */
			tiers: z.record(z.string(), z.number()),
			latency_ms: z.object({ p50: z.number(), p90: z.number(), p99: z.number(), max: z.number() }).nullable(),
			latency_samples: z.number(),
		}),
	})
	.meta({ id: "MetricsSnapshot", description: "The live in-process timing metrics snapshot." })

export type MetricsSnapshot = z.infer<typeof MetricsSnapshotSchema>

/**
 * The current metrics snapshot, with sorted-reservoir percentiles and counters.
 */
export function metricsSnapshot(): MetricsSnapshot {
	const sorted = [...latencies].toSorted((a, b) => a - b)

	return {
		uptime_s: Math.round((Date.now() - startedAt) / 1000),
		timings: {
			total,
			errors,
			tiers: { ...tierCounts },
			latency_ms: sorted.length
				? {
						p50: latencyPercentile(sorted, 50),
						p90: latencyPercentile(sorted, 90),
						p99: latencyPercentile(sorted, 99),
						max: Math.round(sorted.at(-1)! * 100) / 100,
					}
				: null,
			latency_samples: sorted.length,
		},
	}
}

/**
 * Test-only reset of all counters + the reservoir.
 */
export function resetMetricsForTest(): void {
	latencies.length = 0
	writeIdx = 0

	for (const key of Object.keys(tierCounts)) {
		// oxlint-disable-next-line typescript/no-dynamic-delete -- removing one key from a plain record. the object is not on a hot path
		delete tierCounts[key]
	}

	total = 0
	errors = 0
}
