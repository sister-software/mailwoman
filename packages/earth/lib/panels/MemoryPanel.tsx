// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The Developer sheet's memory readout: the device tier, the crash guard, an estimate
 *   of memory pressure from frame timing, and the memory the page can account for itself.
 *
 *   It samples only while its disclosure is open, so a closed readout runs no frame loop or timer.
 */

import { useCallback, useEffect, useState } from "react"

import { loadedModelBytes, mapTileEstimate } from "#memory/ledger"
import { estimatePressure, FrameWindow, type FrameStats } from "#memory/pressure"
import { useMemoryProfile } from "#memory/profile"

import styles from "./memory-panel.module.css"

/**
 * The interval at which an open readout refreshes, in milliseconds.
 */
const REFRESH_MS = 1000

/**
 * How far back the long-frame count reaches, in milliseconds.
 */
const LONG_FRAME_WINDOW_MS = 60_000

const BYTES_PER_MIB = 1024 * 1024

function mib(bytes: number): string {
	return Number.isFinite(bytes) ? `${(bytes / BYTES_PER_MIB).toFixed(0)} MB` : "no limit"
}

/**
 * Chromium's non-standard heap reading.
 */
interface ChromiumHeap {
	usedJSHeapSize: number
	jsHeapSizeLimit: number
}

function chromiumHeap(): ChromiumHeap | null {
	const memory = (performance as Performance & { memory?: ChromiumHeap }).memory

	return memory && memory.jsHeapSizeLimit > 0 ? memory : null
}

/**
 * The long-frame entry type this browser reports, preferring long animation frames.
 */
function longFrameEntryType(): string | null {
	const supported = globalThis.PerformanceObserver?.supportedEntryTypes ?? []

	if (supported.includes("long-animation-frame")) return "long-animation-frame"

	if (supported.includes("longtask")) return "longtask"

	return null
}

interface Sample {
	frames: FrameStats
	longFrames: number | null
	longFrameType: string | null
	heap: ChromiumHeap | null
	rangeWorkers: { workers: number; cachedBytes: number; unanswered: number } | null
	tiles: ReturnType<typeof mapTileEstimate>
}

/**
 * Samples frame time and long frames while `active`, and refreshes the rest every {@linkcode REFRESH_MS}.
 */
function useMemorySample(active: boolean): Sample | null {
	const [sample, setSample] = useState<Sample | null>(null)

	useEffect(() => {
		if (!active) return

		const window = new FrameWindow()
		const longFrameTimes: number[] = []
		const longFrameType = longFrameEntryType()
		let observer: PerformanceObserver | null = null
		let last = performance.now()

		let frame = requestAnimationFrame(function tick(now) {
			window.push(now - last)
			last = now
			frame = requestAnimationFrame(tick)
		})

		if (longFrameType) {
			observer = new PerformanceObserver((list) => {
				for (const entry of list.getEntries()) {
					longFrameTimes.push(entry.startTime)
				}
			})

			observer.observe({ type: longFrameType, buffered: false })
		}

		const refresh = async () => {
			const cutoff = performance.now() - LONG_FRAME_WINDOW_MS

			while (longFrameTimes.length && longFrameTimes[0]! < cutoff) {
				longFrameTimes.shift()
			}

			const { rangeWorkerMemory } = await import("@mailwoman/resolver-wof-wasm/httpvfs/database")

			setSample({
				frames: window.stats(),
				longFrames: longFrameType ? longFrameTimes.length : null,
				longFrameType,
				heap: chromiumHeap(),
				rangeWorkers: await rangeWorkerMemory().catch(() => null),
				tiles: mapTileEstimate(),
			})
		}

		const timer = setInterval(() => void refresh(), REFRESH_MS)

		return () => {
			cancelAnimationFrame(frame)
			clearInterval(timer)
			observer?.disconnect()
		}
	}, [active])

	return active ? sample : null
}

/**
 * `performance.measureUserAgentSpecificMemory()`, which only Chromium offers
 * and only on a cross-origin-isolated page.
 * It can take seconds, so it runs on request.
 */
function usePageMeasurement(): { supported: boolean; bytes: number | null; error: string | null; measure: () => void } {
	const measureFn = (performance as Performance & { measureUserAgentSpecificMemory?: () => Promise<{ bytes: number }> })
		.measureUserAgentSpecificMemory

	const supported = typeof measureFn === "function" && globalThis.crossOriginIsolated === true
	const [bytes, setBytes] = useState<number | null>(null)
	const [error, setError] = useState<string | null>(null)

	const measure = useCallback(() => {
		const run = async () => {
			try {
				setBytes((await measureFn!.call(performance)).bytes)
				setError(null)
			} catch (error_) {
				setError(error_ instanceof Error ? error_.message : String(error_))
			}
		}

		void run()
	}, [measureFn])

	return { supported, bytes, error, measure }
}

/**
 * The Developer sheet's memory readout.
 */
export function MemoryPanel() {
	const [open, setOpen] = useState(false)
	const sample = useMemorySample(open)
	const page = usePageMeasurement()
	const profile = useMemoryProfile()
	const modelBytes = loadedModelBytes()

	// The pressure estimate counts a tripped crash guard, so it waits for the guard's reading.
	const pressure =
		sample && profile
			? estimatePressure({
					frames: sample.frames,
					heapRatio: sample.heap ? sample.heap.usedJSHeapSize / sample.heap.jsHeapSizeLimit : null,
					crashGuardTripped: profile.crashGuard.tripped,
				})
			: null

	return (
		<details className={styles.panel} onToggle={(event) => setOpen(event.currentTarget.open)}>
			<summary className={styles.heading}>Memory</summary>
			<dl className={styles.list}>
				<dt>Device tier</dt>
				<dd>
					{profile ? profile.tier : "checking…"}
					{profile && profile.tier !== profile.detectedTier ? ` (detected ${profile.detectedTier})` : null}
				</dd>

				<dt>Crash guard</dt>
				<dd>
					{!profile
						? "checking…"
						: profile.crashGuard.tripped
							? `tripped: the previous load ended during ${profile.crashGuard.phases.join(", ")}; 3D is off for this load`
							: "clear"}
				</dd>

				<dt>Pressure (estimate)</dt>
				<dd>
					{pressure ? pressure.level : profile ? "sampling…" : "checking…"}
					{pressure?.reasons.length ? ` — ${pressure.reasons.join("; ")}` : null}
				</dd>

				<dt>Frame time</dt>
				<dd className={styles.count}>
					{sample?.frames.p95Ms != null
						? `p95 ${sample.frames.p95Ms.toFixed(1)} ms, ${sample.frames.jankFrames} of ${sample.frames.frames} frames over 50 ms`
						: "sampling…"}
				</dd>

				<dt>Long frames, last minute</dt>
				<dd className={styles.count}>
					{sample
						? sample.longFrameType
							? `${sample.longFrames} (${sample.longFrameType})`
							: "not reported here"
						: "…"}
				</dd>

				<dt>Model file</dt>
				<dd className={styles.count}>{modelBytes != null ? mib(modelBytes) : "not reported"}</dd>

				<dt>ONNX Runtime working memory</dt>
				<dd>not measured</dd>

				<dt>Range-worker chunk caches</dt>
				<dd className={styles.count}>
					{sample?.rangeWorkers
						? `${mib(sample.rangeWorkers.cachedBytes)} across ${sample.rangeWorkers.workers} workers` +
							(sample.rangeWorkers.unanswered ? `, ${sample.rangeWorkers.unanswered} not answering` : "")
						: "…"}
				</dd>

				<dt>3D budget</dt>
				<dd className={styles.count}>
					{!profile
						? "checking…"
						: profile.threeD
							? `${mib(profile.budget.totalBytes)} total, ${mib(profile.budget.perTilesetBytes)} per tileset`
							: "3D off"}
				</dd>

				<dt>MapLibre tiles (estimate)</dt>
				<dd className={styles.count}>
					{sample?.tiles
						? `${sample.tiles.inView} in view + ${sample.tiles.cacheLimit} cached ≈ ${mib(sample.tiles.bytes)}`
						: sample
							? "not readable"
							: "…"}
				</dd>

				<dt>JS heap (Chromium only)</dt>
				<dd className={styles.count}>
					{sample?.heap
						? `${mib(sample.heap.usedJSHeapSize)} of ${mib(sample.heap.jsHeapSizeLimit)}`
						: sample
							? "not reported by this browser"
							: "…"}
				</dd>

				<dt>Page memory (Chromium only)</dt>
				<dd className={styles.count}>
					{page.supported ? (
						<>
							{page.bytes != null ? `${mib(page.bytes)} ` : null}
							{page.error ? `${page.error} ` : null}
							<button type="button" onClick={page.measure}>
								Measure
							</button>
						</>
					) : (
						"needs Chromium on a cross-origin-isolated page"
					)}
				</dd>
			</dl>
		</details>
	)
}
