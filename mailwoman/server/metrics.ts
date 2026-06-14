/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   In-process geocode metrics (#485 observability). Dependency-free: monotonic counters per
 *   resolution tier + a bounded reservoir of recent latencies for percentile estimation. The issue
 *   asks to MEASURE the SLO targets (p99 ≤ 100ms admin, ≤ 250ms with situs) rather than invent them —
 *   this is the instrument. Surfaced by `GET /metrics`; reset on process restart (no persistence —
 *   scrape it).
 */

import type { ResolutionTier } from "../geocode-core.js"

/** Recent-latency reservoir size. ~2k samples gives stable p99 without unbounded memory. */
const MAX_SAMPLES = 2048

const latencies: number[] = []
let writeIdx = 0

const tierCounts: Record<ResolutionTier, number> = { address_point: 0, interpolated: 0, admin: 0 }
let total = 0
let errors = 0
const startedAt = Date.now()

/** Record one completed geocode: its wall-clock latency and which tier produced it (or `"error"`). */
export function recordGeocode(latencyMs: number, tier: ResolutionTier | "error"): void {
	total++
	if (tier === "error") {
		errors++
	} else {
		tierCounts[tier]++
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
	geocode: {
		total: number
		errors: number
		tiers: Record<ResolutionTier, number>
		latency_ms: { p50: number; p90: number; p99: number; max: number } | null
		latency_samples: number
	}
}

/** Current metrics snapshot — sorted-reservoir percentiles + counters. */
export function metricsSnapshot(): MetricsSnapshot {
	const sorted = [...latencies].sort((a, b) => a - b)
	return {
		uptime_s: Math.round((Date.now() - startedAt) / 1000),
		geocode: {
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
export function __resetMetricsForTest(): void {
	latencies.length = 0
	writeIdx = 0
	tierCounts.address_point = 0
	tierCounts.interpolated = 0
	tierCounts.admin = 0
	total = 0
	errors = 0
}
