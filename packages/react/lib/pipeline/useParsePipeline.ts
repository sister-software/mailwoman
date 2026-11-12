// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The headless core of the pipeline explorer.
 *
 *   It owns query text, busy/stage flags, result and candidate selection.
 *   It delegates parse and resolve to the injected {@link PipelineRuntime}.
 */

import type { ParseResult, ResolvedPlaceView } from "@mailwoman/core/pipeline/client-result"
import { useCallback, useRef, useState } from "react"

import type { PipelineRuntime } from "#pipeline/types"

/**
 * The runtime and starting text for {@link useParsePipeline}.
 */
export interface UseParsePipelineOptions {
	runtime: PipelineRuntime
	defaultText: string
}

/**
 * The state and handlers that {@link useParsePipeline} returns.
 */
export interface UseParsePipeline {
	text: string
	setText: (text: string) => void
	busy: boolean
	/**
	 * 0-based index into `runtime.parseStageLabels`; -1 when idle.
	 */
	parseStage: number
	result: ParseResult | null
	parseError: string | null
	selectedCandidateIndex: number
	selectCandidate: (index: number) => void
	/**
	 * The currently-selected candidate (falls back to the first), or null.
	 */
	selectedCandidate: ResolvedPlaceView | null
	/**
	 * Parse and resolve the current text, safe to bind to a form's `onSubmit`;
	 * pass `query` to submit a value the field hasn't re-rendered with yet.
	 *
	 * A submit during a parse queues its query, and the latest queued query runs when that parse settles.
	 */
	submit: (query?: string) => Promise<void>
	/**
	 * Clear the result and the parse error, used when a preset replaces the input.
	 */
	reset: () => void
}

/**
 * Drives the injected runtime and exposes the explorer's UI state.
 */
export function useParsePipeline({ runtime, defaultText }: UseParsePipelineOptions): UseParsePipeline {
	const [text, setText] = useState(defaultText)
	const [busy, setBusy] = useState(false)
	const [parseStage, setParseStage] = useState(-1)
	const [result, setResult] = useState<ParseResult | null>(null)
	const [selectedCandidateIndex, setSelectedCandidateIndex] = useState(0)
	const [parseError, setParseError] = useState<string | null>(null)

	// A ref rather than the `busy` state, because a submit made during a parse runs
	// in a closure rendered before `busy` became true.
	const parsingRef = useRef(false)
	// The latest query submitted during a parse.
	// It runs when that parse settles, and an earlier one it replaced is dropped.
	const queuedRef = useRef<string | null>(null)

	// `setText` doesn't reach this closure before the call after it runs,
	// so a caller that already knows the query passes it.
	const submit = useCallback(
		async (query?: string) => {
			if (!runtime.ready) return

			const input = query ?? text

			if (parsingRef.current) {
				queuedRef.current = input

				return
			}

			parsingRef.current = true
			setBusy(true)

			for (let next: string | null = input; next !== null; next = queuedRef.current) {
				queuedRef.current = null
				setParseStage(0)
				setParseError(null)

				try {
					const parsed = await runtime.runParse(next, { onStage: setParseStage })
					setSelectedCandidateIndex(0)
					setResult(parsed)
				} catch (error) {
					// The error answers this query, so the previous query's result leaves with it.
					setResult(null)
					setParseError(error instanceof Error ? error.message : String(error))
				}
			}

			parsingRef.current = false
			setBusy(false)
			setParseStage(-1)
		},
		[runtime, text]
	)

	const reset = useCallback(() => {
		setResult(null)
		setParseError(null)
	}, [])

	const selectedCandidate = result ? (result.candidates[selectedCandidateIndex] ?? result.candidates[0] ?? null) : null

	return {
		text,
		setText,
		busy,
		parseStage,
		result,
		parseError,
		selectedCandidateIndex,
		selectCandidate: setSelectedCandidateIndex,
		selectedCandidate,
		submit,
		reset,
	}
}
