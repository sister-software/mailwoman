/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Generic in-process timing metrics (ported from `mailwoman/server/metrics.ts`, #485
 *   observability, for the api-kit plumbing layer — see the 2026-07-12 Phase 4a plan's
 *   dependency-arrow correction). Dependency-free: monotonic counters per string-keyed tier + a
 *   bounded reservoir of recent latencies for percentile estimation. Callers own their tier
 *   vocabulary (e.g. `mailwoman`'s `ResolutionTier`); this module only ever sees `string`.
 *   Surfaced by `GET /metrics`; reset on process restart (no persistence — scrape it). Per-process
 *   state: under `node:cluster` each worker reports its own snapshot — aggregate at the scraper.
 */

/** Recent-latency reservoir size. ~2k samples gives stable p99 without unbounded memory. */
const MAX_SAMPLES = 2048

const latencies: number[] = []
let writeIdx = 0

/** Null-prototype: tier keys are created lazily on first use, not eagerly pre-populated. */
const tierCounts: Record<string, number> = Object.create(null)
let total = 0
let errors = 0
const startedAt = Date.now()

/**
 * Record one completed timed operation: its wall-clock latency and which tier produced it (or `"error"`). Tier keys are
 * created on first use; "error" is reserved and counts toward errors instead of a tier.
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

function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return 0
	const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length))

	return Math.round(sorted[idx]! * 100) / 100
}

export interface MetricsSnapshot {
	uptime_s: number
	timings: {
		total: number
		errors: number
		/**
		 * Per-tier counts. Keys are created lazily on the first `recordTimed` call for that tier — a tier never recorded is
		 * absent, not zero.
		 */
		tiers: Record<string, number>
		latency_ms: { p50: number; p90: number; p99: number; max: number } | null
		latency_samples: number
	}
}

/** Current metrics snapshot — sorted-reservoir percentiles + counters. */
export function metricsSnapshot(): MetricsSnapshot {
	const sorted = [...latencies].sort((a, b) => a - b)

	return {
		uptime_s: Math.round((Date.now() - startedAt) / 1000),
		timings: {
			total,
			errors,
			tiers: { ...tierCounts },
			latency_ms: sorted.length
				? {
						p50: percentile(sorted, 0.5),
						p90: percentile(sorted, 0.9),
						p99: percentile(sorted, 0.99),
						max: Math.round(sorted[sorted.length - 1]! * 100) / 100,
					}
				: null,
			latency_samples: sorted.length,
		},
	}
}

/** Test-only reset of all counters + the reservoir. */
export function resetMetricsForTest(): void {
	latencies.length = 0
	writeIdx = 0

	for (const key of Object.keys(tierCounts)) {
		delete tierCounts[key]
	}

	total = 0
	errors = 0
}
