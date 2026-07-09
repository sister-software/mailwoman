/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { expect, test } from "vitest"

import { __resetMetricsForTest, metricsSnapshot, recordGeocode } from "./metrics.js"

// `percentile` is module-private, so we exercise it through the public `metricsSnapshot`
// surface. The estimator is nearest-rank by index: idx = min(n-1, floor(p·n)), so for the
// sorted reservoir [1..10] (n=10) p50 → a[5]=6, p90 → a[9]=10, p99 → a[9]=10.

test("metricsSnapshot: percentiles over a known reservoir [1..10]", () => {
	__resetMetricsForTest()

	for (let v = 1; v <= 10; v++) {
		recordGeocode(v, "admin")
	}

	const snap = metricsSnapshot()
	expect(snap.geocode.latency_samples).toBe(10)
	expect(snap.geocode.latency_ms).not.toBeNull()
	expect(snap.geocode.latency_ms).toMatchObject({ p50: 6, p90: 10, p99: 10, max: 10 })
})

test("metricsSnapshot: empty reservoir reports null latency and zero samples", () => {
	__resetMetricsForTest()
	const snap = metricsSnapshot()
	expect(snap.geocode.latency_samples).toBe(0)
	expect(snap.geocode.latency_ms).toBeNull()
	expect(snap.geocode.total).toBe(0)
	expect(snap.geocode.errors).toBe(0)
})

test("metricsSnapshot: a single sample is its own p50/p90/p99/max", () => {
	__resetMetricsForTest()
	recordGeocode(42, "address_point")
	const { latency_ms } = metricsSnapshot().geocode
	expect(latency_ms).toEqual({ p50: 42, p90: 42, p99: 42, max: 42 })
})

test("metricsSnapshot: latency values are rounded to two decimals", () => {
	__resetMetricsForTest()
	recordGeocode(1.239, "admin")
	expect(metricsSnapshot().geocode.latency_ms?.p50).toBe(1.24)
})

test("metricsSnapshot: snapshot sorts an unsorted insertion order before taking percentiles", () => {
	__resetMetricsForTest()

	for (const v of [10, 1, 7, 3, 9, 2, 8, 4, 6, 5]) {
		recordGeocode(v, "admin")
	}
	// Same multiset as [1..10] → same percentiles regardless of arrival order.
	expect(metricsSnapshot().geocode.latency_ms).toMatchObject({ p50: 6, p90: 10, p99: 10, max: 10 })
})

test("recordGeocode: counts total, partitions by tier, and tallies errors separately", () => {
	__resetMetricsForTest()
	recordGeocode(5, "address_point")
	recordGeocode(5, "address_point")
	recordGeocode(5, "interpolated")
	recordGeocode(5, "admin")
	recordGeocode(5, "error")

	const g = metricsSnapshot().geocode
	expect(g.total).toBe(5) // every call, errors included
	expect(g.errors).toBe(1)
	expect(g.tiers).toEqual({ address_point: 2, interpolated: 1, street: 0, admin: 1 })
})

test("recordGeocode: an error still records its latency in the reservoir", () => {
	// The error branch skips the tier counter but the latency push runs unconditionally.
	__resetMetricsForTest()
	recordGeocode(99, "error")
	const g = metricsSnapshot().geocode
	expect(g.latency_samples).toBe(1)
	expect(g.latency_ms?.max).toBe(99)
	expect(g.errors).toBe(1)
	expect(g.tiers).toEqual({ address_point: 0, interpolated: 0, street: 0, admin: 0 })
})

test("__resetMetricsForTest: clears counters and the reservoir", () => {
	recordGeocode(123, "admin")
	__resetMetricsForTest()
	const g = metricsSnapshot().geocode
	expect(g.total).toBe(0)
	expect(g.latency_samples).toBe(0)
	expect(g.latency_ms).toBeNull()
})
