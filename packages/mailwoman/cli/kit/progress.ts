/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Ink rendering for the `progress` events a core `ProcessTask` or `GitClient` dispatches.
 *   Written without JSX because Node type stripping cannot compile it.
 */

import { ByteFormatter } from "@mailwoman/core/fs/formatters"
import type { ProcessProgress } from "@mailwoman/core/process"
import { TypedEventTarget } from "@mailwoman/core/utils/events"
import { Box, Text } from "ink"
import { createElement as h, useCallback, useState } from "react"
import type * as React from "react"

/**
 * A source of progress events: any core event target whose `progress` detail
 * includes the command line it came from.
 */
export interface ProgressSource {
	on(type: "progress", listener: (detail: ProcessProgress & { command: string }) => void): () => void
}

/**
 * The latest progress step for each running transfer, keyed by the label its source
 * was watched under, or by its command line when the source has no label.
 */
export type ProgressEntries = ReadonlyMap<string, ProcessProgress>

/**
 * The byte step a transfer without a stated length reports at: one per megabyte.
 */
const UNSIZED_STEP_BYTES = 1_000_000

/**
 * A {@linkcode ProgressSource} for byte transfers, such as the downloads
 * `streamToDisk` reports through `onBytes`.
 *
 * Each label's step is its bytes on disk against the total, as `12.3 MB of 456 MB` with the percent.
 * A step is emitted only when the whole percent changes, or for a transfer of unknown length when
 * another megabyte arrives, so a per-chunk report causes at most about a hundred renders per transfer.
 */
export class TransferProgress extends TypedEventTarget<{ progress: ProcessProgress & { command: string } }> {
	#shown = new Map<string, number>()

	/**
	 * Report `received` bytes of `total` for the transfer whose progress line `label` keys.
	 */
	public report(label: string, received: number, total: number | null): void {
		const sized = total != null && total > 0

		const position = sized
			? Math.floor((Math.min(received, total) / total) * 100)
			: Math.floor(received / UNSIZED_STEP_BYTES)

		if (this.#shown.get(label) === position) return

		this.#shown.set(label, position)

		this.emit("progress", {
			command: label,
			stage: sized
				? `${ByteFormatter.formatSI(received)} of ${ByteFormatter.formatSI(total)}`
				: ByteFormatter.formatSI(received),
			...(sized ? { percent: position } : {}),
		})
	}
}

/**
 * What {@linkcode useProgressFeed} answers.
 */
export interface ProgressFeed {
	entries: ProgressEntries
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
 */
export function useProgressFeed(): ProgressFeed {
	const [entries, setEntries] = useState<ProgressEntries>(new Map())

	const watch = useCallback(
		(source: ProgressSource, label?: string) =>
			source.on("progress", ({ command, ...step }) => {
				const key = label ?? command

				setEntries((current) => {
					const previous = current.get(key)

					if (previous?.stage === step.stage && previous.percent === step.percent) return current

					return new Map(current).set(key, step)
				})
			}),
		[]
	)

	const clear = useCallback((key: string) => {
		setEntries((current) => {
			if (!current.has(key)) return current

			const next = new Map(current)

			next.delete(key)

			return next
		})
	}, [])

	return { entries, watch, clear }
}

/**
 * One line per running transfer, with its stage, percentage and counts.
 */
export function ProgressLines({ entries }: { entries: ProgressEntries }): React.ReactElement {
	return h(
		Box,
		{ flexDirection: "column" },
		[...entries].map(([key, step]) =>
			h(
				Text,
				{ key, color: "cyan" },
				` ${key}: ${step.stage}${!step.percent ? "" : ` ${step.percent}%`}` +
					(!step.total ? "" : ` (${step.processed ?? 0}/${step.total})`)
			)
		)
	)
}
