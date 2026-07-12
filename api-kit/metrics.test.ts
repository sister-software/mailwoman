/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { expect, test } from "vitest"

import { metricsSnapshot, recordTimed, resetMetricsForTest } from "./metrics.ts"

// `percentile` is module-private, so we exercise it through the public `metricsSnapshot`
// surface. The estimator is nearest-rank by index: idx = min(n-1, floor(p·n)), so for the
// sorted reservoir [1..10] (n=10) p50 → a[5]=6, p90 → a[9]=10, p99 → a[9]=10.

test("metricsSnapshot: percentiles over a known reservoir [1..10]", () => {
	resetMetricsForTest()

	for (let v = 1; v <= 10; v++) {
		recordTimed(v, "admin")
	}

	const snap = metricsSnapshot()
	expect(snap.timings.latency_samples).toBe(10)
	expect(snap.timings.latency_ms).not.toBeNull()
	expect(snap.timings.latency_ms).toMatchObject({ p50: 6, p90: 10, p99: 10, max: 10 })
})

test("metricsSnapshot: empty reservoir reports null latency and zero samples", () => {
	resetMetricsForTest()
	const snap = metricsSnapshot()
	expect(snap.timings.latency_samples).toBe(0)
	expect(snap.timings.latency_ms).toBeNull()
	expect(snap.timings.total).toBe(0)
	expect(snap.timings.errors).toBe(0)
})

test("metricsSnapshot: a single sample is its own p50/p90/p99/max", () => {
	resetMetricsForTest()
	recordTimed(42, "address_point")
	const { latency_ms } = metricsSnapshot().timings
	expect(latency_ms).toEqual({ p50: 42, p90: 42, p99: 42, max: 42 })
})

test("metricsSnapshot: latency values are rounded to two decimals", () => {
	resetMetricsForTest()
	recordTimed(1.239, "admin")
	expect(metricsSnapshot().timings.latency_ms?.p50).toBe(1.24)
})

test("metricsSnapshot: snapshot sorts an unsorted insertion order before taking percentiles", () => {
	resetMetricsForTest()

	for (const v of [10, 1, 7, 3, 9, 2, 8, 4, 6, 5]) {
		recordTimed(v, "admin")
	}
	// Same multiset as [1..10] → same percentiles regardless of arrival order.
	expect(metricsSnapshot().timings.latency_ms).toMatchObject({ p50: 6, p90: 10, p99: 10, max: 10 })
})

test("recordTimed: counts total, partitions by tier (created on first use), and tallies errors separately", () => {
	resetMetricsForTest()
	recordTimed(5, "address_point")
	recordTimed(5, "address_point")
	recordTimed(5, "interpolated")
	recordTimed(5, "admin")
	recordTimed(5, "error")

	const timings = metricsSnapshot().timings
	expect(timings.total).toBe(5) // every call, errors included
	expect(timings.errors).toBe(1)
	expect(timings.tiers).toEqual({ address_point: 2, interpolated: 1, admin: 1 })
})

test("recordTimed: an error still records its latency in the reservoir", () => {
	// The error branch skips the tier counter but the latency push runs unconditionally.
	resetMetricsForTest()
	recordTimed(99, "error")
	const timings = metricsSnapshot().timings
	expect(timings.latency_samples).toBe(1)
	expect(timings.latency_ms?.max).toBe(99)
	expect(timings.errors).toBe(1)
	expect(timings.tiers).toEqual({})
})

test("resetMetricsForTest: clears counters and the reservoir", () => {
	recordTimed(123, "admin")
	resetMetricsForTest()
	const timings = metricsSnapshot().timings
	expect(timings.total).toBe(0)
	expect(timings.latency_samples).toBe(0)
	expect(timings.latency_ms).toBeNull()
})

test("recordTimed: tier keys are created on first use (no eager pre-population)", () => {
	resetMetricsForTest()
	expect(metricsSnapshot().timings.tiers).toEqual({})
	recordTimed(1, "street")
	expect(metricsSnapshot().timings.tiers).toEqual({ street: 1 })
})
