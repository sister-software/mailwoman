// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   An estimate of memory pressure from the readings a page can take in every browser.
 *
 *   No browser reports memory pressure to a page.
 *   Safari reports no memory figure at all.
 *
 *   Frame time is available everywhere, and a page near its memory limit tends to drop
 *   frames to garbage collection and texture eviction, so the estimate leans on frame time.
 *   Chromium's heap reading joins it where present.
 *
 *   The thresholds are starting points.
 *   No device measurement has validated them yet.
 */

import { percentile } from "@mailwoman/core/stats"

/**
 * The estimate's levels.
 */
export const MemoryPressure = {
	Low: "low",
	Elevated: "elevated",
	High: "high",
} as const

export type MemoryPressure = (typeof MemoryPressure)[keyof typeof MemoryPressure]

/**
 * A frame longer than this, in milliseconds, counts as jank: it misses at least two 60 Hz vsyncs.
 */
export const JANK_FRAME_MS = 50

/**
 * The 95th-percentile frame time, in milliseconds, at which the estimate rises to elevated:
 * the page holds under 40 frames per second for one frame in twenty.
 */
export const ELEVATED_P95_MS = 25

/**
 * The 95th-percentile frame time, in milliseconds, at which the estimate rises to high.
 */
export const HIGH_P95_MS = 50

/**
 * The share of Chromium's JS heap limit in use at which the estimate rises to elevated.
 */
export const ELEVATED_HEAP_RATIO = 0.6

/**
 * The share of Chromium's JS heap limit in use at which the estimate rises to high.
 */
export const HIGH_HEAP_RATIO = 0.85

/**
 * The frames a rolling window keeps, about four seconds at 60 Hz.
 */
export const FRAME_WINDOW = 240

/**
 * Frame-time figures over one window.
 */
export interface FrameStats {
	frames: number
	/**
	 * The nearest-rank 95th-percentile frame time in milliseconds, or `null` before any frame.
	 */
	p95Ms: number | null
	/**
	 * The count of frames longer than {@linkcode JANK_FRAME_MS}.
	 */
	jankFrames: number
}

/**
 * A rolling window of frame durations.
 */
export class FrameWindow {
	readonly capacity: number
	#durations: number[] = []

	constructor(capacity = FRAME_WINDOW) {
		this.capacity = capacity
	}

	push(durationMs: number): void {
		this.#durations.push(durationMs)

		if (this.#durations.length > this.capacity) {
			this.#durations.shift()
		}
	}

	stats(): FrameStats {
		return {
			frames: this.#durations.length,
			p95Ms: percentile(this.#durations, 95),
			jankFrames: this.#durations.filter((ms) => ms > JANK_FRAME_MS).length,
		}
	}
}

/**
 * The readings the estimate combines.
 */
export interface PressureReadings {
	frames: FrameStats
	/**
	 * `usedJSHeapSize / jsHeapSizeLimit` from Chromium's `performance.memory`, or `null` elsewhere.
	 */
	heapRatio: number | null
	/**
	 * Whether this load followed a load that ended during a heavy phase.
	 */
	crashGuardTripped: boolean
}

/**
 * The estimated level and the readings that set it.
 */
export interface PressureEstimate {
	level: MemoryPressure
	reasons: string[]
}

/**
 * Estimates memory pressure from frame time, the heap ratio where present, and the crash guard.
 *
 * The highest level any reading reaches decides, and each reading that raised it is listed.
 */
export function estimatePressure({ frames, heapRatio, crashGuardTripped }: PressureReadings): PressureEstimate {
	const high: string[] = []
	const elevated: string[] = []

	if (crashGuardTripped) {
		high.push("the previous load ended during a heavy phase")
	}

	if (frames.p95Ms != null) {
		const p95 = `frame p95 ${frames.p95Ms.toFixed(0)} ms`

		if (frames.p95Ms >= HIGH_P95_MS) {
			high.push(p95)
		} else if (frames.p95Ms >= ELEVATED_P95_MS) {
			elevated.push(p95)
		}
	}

	if (heapRatio != null) {
		const heap = `JS heap ${(heapRatio * 100).toFixed(0)}% of its limit`

		if (heapRatio >= HIGH_HEAP_RATIO) {
			high.push(heap)
		} else if (heapRatio >= ELEVATED_HEAP_RATIO) {
			elevated.push(heap)
		}
	}

	if (high.length) return { level: MemoryPressure.High, reasons: high }

	if (elevated.length) return { level: MemoryPressure.Elevated, reasons: elevated }

	return { level: MemoryPressure.Low, reasons: [] }
}
