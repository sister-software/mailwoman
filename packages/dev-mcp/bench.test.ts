/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { assembleBench, summarizeLatency } from "./bench.ts"

describe("summarizeLatency", () => {
	it("reports nearest-rank percentiles on a known sample", () => {
		const reading = summarizeLatency([10, 20, 30, 40, 50, 60, 70, 80, 90, 100])

		expect(reading.n).toBe(10)
		expect(reading.p50_ms).toBe(60)
		expect(reading.p90_ms).toBe(100)
		expect(reading.max_ms).toBe(100)
		expect(reading.mean_ms).toBe(55)
	})

	it("passes p in [0, 100], not a fraction", () => {
		// The unit AGENTS.md flags specifically. A fraction would floor to index 0 and report the MINIMUM as the median.
		const reading = summarizeLatency([1, 2, 3, 4, 100])

		expect(reading.p50_ms).not.toBe(1)
		expect(reading.p50_ms).toBe(3)
	})

	it("derives throughput from the mean, not from a wall clock", () => {
		expect(summarizeLatency([100, 100, 100]).throughput_per_s).toBeCloseTo(10, 5)
	})

	it("reports an empty sample as nulls rather than zeros", () => {
		// A latency of 0ms and no measurement are different claims, and only one of them is flattering.
		const reading = summarizeLatency([])

		expect(reading).toMatchObject({ n: 0, p50_ms: null, max_ms: null, throughput_per_s: null })
	})
})

describe("assembleBench", () => {
	const warm = summarizeLatency([100, 110, 120])

	it("says so loudly when the cold start was not measured", () => {
		// A warm daemon makes it easy to publish a number no user sees. Absence of a cold measurement is stated, never
		// left to be read as zero.
		const reading = assembleBench(null, warm)

		expect(reading.cold).toBeNull()
		expect(reading.summary).toContain("Cold start NOT measured")
		expect(reading.summary).toContain("says nothing about what a user's first query costs")
	})

	it("leads with the cold cost when it was measured", () => {
		const reading = assembleBench({ engine_build_ms: 1000, first_query_ms: 250, total_ms: 1370 }, warm)

		expect(reading.summary.startsWith("Cold: 1370ms to first answer")).toBe(true)
		expect(reading.summary).toContain("1000ms was engine construction")
	})

	it("pins concurrency at 1 and explains it rather than asserting it", () => {
		const reading = assembleBench(null, warm)

		expect(reading.concurrency).toBe(1)
		expect(reading.note).toContain("blocks the calling thread")
		expect(reading.note).toContain("peaking at 2 workers")
	})

	it("does not invent a warm figure when nothing was sampled", () => {
		expect(assembleBench(null, summarizeLatency([])).summary).toContain("No warm samples were taken")
	})
})
