// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, test } from "vitest"

import { estimatePressure, FrameWindow, MemoryPressure } from "#memory/pressure"

function framesOf(durations: number[]) {
	const window = new FrameWindow(durations.length)

	for (const ms of durations) {
		window.push(ms)
	}

	return window.stats()
}

describe("FrameWindow", () => {
	test("keeps only the last `capacity` frames", () => {
		const window = new FrameWindow(3)

		for (const ms of [100, 16, 16, 16]) {
			window.push(ms)
		}

		expect(window.stats()).toEqual({ frames: 3, p95Ms: 16, jankFrames: 0 })
	})

	test("counts frames over 50 ms as jank", () => {
		expect(framesOf([16, 51, 60, 16]).jankFrames).toBe(2)
	})

	test("reports no percentile before a frame", () => {
		expect(new FrameWindow().stats()).toEqual({ frames: 0, p95Ms: null, jankFrames: 0 })
	})
})

describe("estimatePressure", () => {
	const smooth = framesOf(Array.from({ length: 100 }, () => 16))

	test("is low at 60 Hz with no heap reading", () => {
		expect(estimatePressure({ frames: smooth, heapRatio: null, crashGuardTripped: false })).toEqual({
			level: MemoryPressure.Low,
			reasons: [],
		})
	})

	test("is elevated when the frame p95 reaches 25 ms", () => {
		const frames = framesOf([...Array.from({ length: 90 }, () => 16), ...Array.from({ length: 10 }, () => 30)])

		expect(estimatePressure({ frames, heapRatio: null, crashGuardTripped: false }).level).toBe(MemoryPressure.Elevated)
	})

	test("is high when the heap passes 85% of its limit, whatever the frames", () => {
		const estimate = estimatePressure({ frames: smooth, heapRatio: 0.9, crashGuardTripped: false })

		expect(estimate.level).toBe(MemoryPressure.High)
		expect(estimate.reasons).toEqual(["JS heap 90% of its limit"])
	})

	test("is high after a tripped crash guard", () => {
		expect(estimatePressure({ frames: smooth, heapRatio: null, crashGuardTripped: true }).level).toBe(
			MemoryPressure.High
		)
	})
})
