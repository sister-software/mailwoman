// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Ink rendering for the `progress` events a core `ProcessTask` or `GitClient` dispatches.
 *
 *   Written without JSX because Node type stripping cannot compile it.
 */

import { ByteFormatter } from "@mailwoman/core/fs/formatters"
import type { ProcessProgress } from "@mailwoman/core/scripting/process"
import { TypedEventTarget } from "@mailwoman/core/utils/events"
import { Box, Text, useStderr, useStdout } from "ink"
import { createElement as h, useCallback, useState } from "react"
import type * as React from "react"

import { redrawsInPlace } from "#cli/native/spec"

/**
 * A progress step, with the transfer rate and the time remaining when a byte transfer has measured them.
 */
export interface ProgressStep extends ProcessProgress {
	/**
	 * Bytes per second since the transfer started, excluding any resumed offset.
	 */
	bytesPerSecond?: number
	/**
	 * Seconds until the transfer completes at {@link bytesPerSecond}.
	 */
	secondsRemaining?: number
}

/**
 * A source of progress events: any core event target whose `progress` detail
 * includes the command line it came from.
 */
export interface ProgressSource {
	on(type: "progress", listener: (detail: ProgressStep & { command: string }) => void): () => void
}

/**
 * The latest progress step for each running transfer, keyed by the label its source
 * was watched under, or by its command line when the source has no label.
 */
export type ProgressEntries = ReadonlyMap<string, ProgressStep>

/**
 * The percent, byte and time intervals at which {@linkcode TransferProgress} emits its steps.
 */
export interface TransferProgressOptions {
	/**
	 * The percent a sized transfer must advance before another step.
	 * Default 1.
	 */
	percentStep?: number
	/**
	 * The bytes a transfer without a stated length must advance before another step.
	 * Default one megabyte.
	 */
	unsizedStepBytes?: number
	/**
	 * The milliseconds after which a step is emitted even without a percent change,
	 * so the rate and remaining time stay current on a slow transfer.
	 *
	 * Default 1000.
	 * `Infinity` turns it off.
	 */
	refreshMs?: number
	/**
	 * The clock, in milliseconds.
	 * Default `performance.now()`.
	 */
	now?: () => number
}

/**
 * The milliseconds a transfer must run before its rate is reported.
 *
 * A shorter sample is dominated by connection setup and the first buffered chunk.
 */
const RATE_SAMPLE_MS = 1000

interface TransferState {
	startedAt: number
	startBytes: number
	position: number
	emittedAt: number
}

/**
 * A {@linkcode ProgressSource} for byte transfers, such as the downloads
 * `streamToDisk` reports through `onBytes`.
 *
 * Each label's step is its bytes on disk against the total, as `12.3 MB of 456 MB` with the
 * percent, the average rate since the transfer began, and the time remaining at that rate.
 * A step is emitted when the percent advances by {@link TransferProgressOptions.percentStep},
 * or when {@link TransferProgressOptions.refreshMs} has passed, so a per-chunk
 * report causes about one render per percent or per second.
 */
export class TransferProgress extends TypedEventTarget<{ progress: ProgressStep & { command: string } }> {
	#transfers = new Map<string, TransferState>()
	#percentStep: number
	#unsizedStepBytes: number
	#refreshMs: number
	#now: () => number

	public constructor(options: TransferProgressOptions = {}) {
		super()
		this.#percentStep = options.percentStep ?? 1
		this.#unsizedStepBytes = options.unsizedStepBytes ?? 1_000_000
		this.#refreshMs = options.refreshMs ?? 1000
		this.#now = options.now ?? (() => performance.now())
	}

	/**
	 * Report `received` bytes of `total` for the transfer whose progress line `label` keys.
	 */
	public report(label: string, received: number, total: number | null): void {
		const now = this.#now()
		const sized = total != null && total > 0
		const percent = sized ? Math.floor((Math.min(received, total) / total) * 100) : null
		const step = percent != null ? percent / this.#percentStep : received / this.#unsizedStepBytes
		const position = Math.floor(step)
		const state = this.#transfers.get(label)

		if (!state) {
			this.#transfers.set(label, { startedAt: now, startBytes: received, position, emittedAt: now })
		} else {
			const advanced = position !== state.position
			const refreshed = now - state.emittedAt >= this.#refreshMs

			if (!advanced && !refreshed) return

			state.position = position
			state.emittedAt = now
		}

		const { startedAt, startBytes } = this.#transfers.get(label)!
		const elapsedMs = now - startedAt
		const bytesPerSecond = elapsedMs >= RATE_SAMPLE_MS ? ((received - startBytes) * 1000) / elapsedMs : null

		const secondsRemaining =
			sized && bytesPerSecond != null && bytesPerSecond > 0 ? Math.max(0, total - received) / bytesPerSecond : null

		this.emit("progress", {
			command: label,
			stage: sized
				? `${ByteFormatter.formatSI(received)} of ${ByteFormatter.formatSI(total)}`
				: ByteFormatter.formatSI(received),
			...(percent != null ? { percent } : {}),
			...(bytesPerSecond != null ? { bytesPerSecond } : {}),
			...(secondsRemaining != null ? { secondsRemaining } : {}),
		})
	}
}

const SECONDS_PER_MINUTE = 60

const MINUTES_PER_HOUR = 60

/**
 * The time remaining as `45s`, `2m 05s` or `1h 12m`.
 */
function formatRemaining(seconds: number): string {
	const whole = Math.ceil(seconds)

	if (whole < SECONDS_PER_MINUTE) return `${whole}s`

	const minutes = Math.floor(whole / SECONDS_PER_MINUTE)

	if (minutes < MINUTES_PER_HOUR) return `${minutes}m ${String(whole % SECONDS_PER_MINUTE).padStart(2, "0")}s`

	return `${Math.floor(minutes / MINUTES_PER_HOUR)}h ${String(minutes % MINUTES_PER_HOUR).padStart(2, "0")}m`
}

/**
 * The number of cells in a progress bar.
 */
const BAR_CELLS = 24

/**
 * One progress step as a line: the bar and percent when the step states a percent,
 * then the stage, the counts, the rate and the time remaining.
 *
 * `ProgressLines` draws it.
 */
export function describeProgressStep(key: string, step: ProgressStep): string {
	return `${key}: ${progressStepParts(step, true).join("  ")}`
}

/**
 * A step's parts, led by the bar and percent when `bar` is set and the step states a percent.
 * Without the bar, the percent leads as `50%`.
 */
function progressStepParts(step: ProgressStep, bar: boolean): string[] {
	const parts: string[] = []

	if (step.percent != null && !bar) {
		parts.push(`${step.percent}%`)
	}

	if (step.percent != null && bar) {
		const filled = Math.round((Math.min(100, Math.max(0, step.percent)) / 100) * BAR_CELLS)

		parts.push(`${"█".repeat(filled)}${"░".repeat(BAR_CELLS - filled)}`, `${String(step.percent).padStart(3)}%`)
	}

	parts.push(step.stage)

	if (step.total) {
		parts.push(`(${step.processed ?? 0}/${step.total})`)
	}

	if (step.bytesPerSecond != null) {
		parts.push(`${ByteFormatter.formatSI(step.bytesPerSecond)}/s`)
	}

	if (step.secondsRemaining != null && step.percent !== 100) {
		parts.push(`${formatRemaining(step.secondsRemaining)} left`)
	}

	return parts
}

/**
 * The plain line a command whose frame doesn't redraw writes to stderr for one report:
 * `<ISO UTC time> [name] detail`, or `<ISO UTC time> [name]` without a detail.
 */
function formatLogLine(name: string, detail: string | null): string {
	return `${new Date().toISOString()} [${name}]${detail ? ` ${detail}` : ""}\n`
}

/**
 * Whether a command's progress is drawn in its frame: `inline` isn't false
 * and Ink redraws the frame in place.
 */
function useLiveProgress(inline: boolean | undefined): { live: boolean; stderr: NodeJS.WritableStream } {
	const { stdout } = useStdout()
	const { stderr } = useStderr()

	return { live: inline !== false && redrawsInPlace(stdout), stderr }
}

/**
 * What {@linkcode useProgressFeed} answers.
 */
export interface ProgressFeed {
	/**
	 * The latest step per key, kept only while the frame redraws in place.
	 */
	entries: ProgressEntries
	/**
	 * Whether steps are drawn in the frame rather than written to stderr.
	 */
	live: boolean
	/**
	 * Subscribe to a source for the rest of the command, answering the function that unsubscribes.
	 *
	 * A `label` such as a repository name keys every step from the source,
	 * so the source's successive commands share one line.
	 */
	watch(source: ProgressSource, label?: string): () => void
	/**
	 * Remove an entry once its transfer has finished.
	 */
	clear(key: string): void
}

/**
 * Collect the latest progress step per command from the sources a command task watches.
 *
 * A step that repeats the stage and percent already shown is dropped.
 * Git redraws its byte rate between percentage changes, and those redraws cause no render.
 *
 * When the frame doesn't redraw in place, each step is written to stderr as a timestamped
 * line without the bar, as {@linkcode useStageProgress} writes a stage.
 */
export function useProgressFeed(options: { inline?: boolean } = {}): ProgressFeed {
	const { live, stderr } = useLiveProgress(options.inline)
	const [entries, setEntries] = useState<ProgressEntries>(new Map())

	const watch = useCallback(
		(source: ProgressSource, label?: string) =>
			source.on("progress", ({ command, ...step }) => {
				const key = label ?? command

				if (!live) {
					stderr.write(formatLogLine(key, progressStepParts(step, false).join("  ")))

					return
				}

				setEntries((current) => {
					const previous = current.get(key)

					if (
						previous?.stage === step.stage &&
						previous.percent === step.percent &&
						previous.bytesPerSecond === step.bytesPerSecond
					) {
						return current
					}

					return new Map(current).set(key, step)
				})
			}),
		[live, stderr]
	)

	const clear = useCallback((key: string) => {
		setEntries((current) => {
			if (!current.has(key)) return current

			const next = new Map(current)

			next.delete(key)

			return next
		})
	}, [])

	return { entries, live, watch, clear }
}

/**
 * The latest stage a long-running command reported, and its detail when it gave one.
 */
export interface Stage<T = string> {
	name: string
	detail?: T
}

/**
 * How {@linkcode useStageProgress} writes a stage's detail, and whether it may draw in the frame.
 */
export interface StageProgressOptions<T> {
	/**
	 * The detail as text.
	 *
	 * Default `String`.
	 * Pass a function declared outside the component, so `report` keeps one identity.
	 */
	describe?: (detail: T) => string
	/**
	 * False keeps progress out of the frame, as for a command that writes a `--json` report to stdout.
	 *
	 * Its stages then go to stderr as plain lines.
	 * Default true.
	 */
	inline?: boolean
}

/**
 * What {@linkcode useStageProgress} answers.
 */
export interface StageProgress<T> {
	/**
	 * The latest stage, kept only while the frame redraws in place.
	 */
	current: Stage<T> | null
	/**
	 * Whether stages are drawn in the frame rather than written to stderr.
	 */
	live: boolean
	/**
	 * Report a stage: the frame's state on a terminal, otherwise one stderr line.
	 */
	report(name: string, detail?: T): void
	/**
	 * A reporter bound to one stage name, for a library callback that passes only the detail.
	 */
	stage(name: string): (detail?: T) => void
	/**
	 * The detail as text, as {@linkcode StageProgressOptions.describe} gives it.
	 */
	describe(detail: T): string
}

/**
 * A stage's detail as text, or `null` when it gave none.
 */
function describeDetail<T>(stage: Stage<T>, describe: (detail: T) => string): string | null {
	return stage.detail == null ? null : describe(stage.detail)
}

/**
 * Report a long-running command's stages to its terminal frame, or to stderr when the frame doesn't redraw.
 *
 * When Ink redraws in place (see `redrawsInPlace`), the latest stage is React state the command draws.
 * Otherwise Ink writes only its final frame at exit, so each stage is written to stderr at once
 * as `<ISO UTC time> [name] detail`, and no state changes, so the frame isn't drawn per stage.
 */
export function useStageProgress<T = string>(options: StageProgressOptions<T> = {}): StageProgress<T> {
	const { live, stderr } = useLiveProgress(options.inline)
	const describe = options.describe ?? String
	const [current, setCurrent] = useState<Stage<T> | null>(null)

	const report = useCallback(
		(name: string, detail?: T) => {
			const stage: Stage<T> = detail == null ? { name } : { name, detail }

			if (live) {
				setCurrent(stage)

				return
			}

			stderr.write(formatLogLine(name, describeDetail(stage, describe)))
		},
		[live, stderr, describe]
	)

	const stage = useCallback((name: string) => (detail?: T) => report(name, detail), [report])

	return { current, live, report, stage, describe }
}

/**
 * The latest stage of a {@linkcode useStageProgress} feed as a dim `[name] detail` line,
 * or `null` before the first stage and whenever stages go to stderr.
 */
export function StageLine<T>({ progress }: { progress: StageProgress<T> }): React.ReactElement | null {
	const { current } = progress

	if (!current) return null

	const detail = describeDetail(current, progress.describe)

	return h(Text, { dimColor: true }, `[${current.name}]${detail ? ` ${detail}` : ""}`)
}

/**
 * One line per running transfer, as {@linkcode describeProgressStep} writes it.
 */
export function ProgressLines({ entries }: { entries: ProgressEntries }): React.ReactElement {
	return h(
		Box,
		{ flexDirection: "column" },
		[...entries].map(([key, step]) => h(Text, { key, color: "cyan" }, ` ${describeProgressStep(key, step)}`))
	)
}
