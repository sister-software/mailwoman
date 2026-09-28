/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The headless core of the pipeline explorer: owns the query text, busy/stage flags, result, and candidate
 *   selection, and delegates parse+resolve to the injected {@link PipelineRuntime}.
 */

import type { ParseResult, ResolvedPlaceView } from "@mailwoman/core/pipeline/client-result"
import { useCallback, useState } from "react"

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
	 * Parse and resolve the current text, safe to bind to a form's `onSubmit`; pass `query` to submit a value
	 * the field has not re-rendered with yet.
	 */
	submit: (query?: string) => Promise<void>
	/**
	 * Clear the result, used when a preset replaces the input.
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

	// `setText` does not reach this closure before the call after it runs, so a caller that already knows the query passes it.
	const submit = useCallback(
		async (query?: string) => {
			if (!runtime.ready || busy) return

			const input = query ?? text

			setBusy(true)
			setParseStage(0)
			setParseError(null)

			try {
				const parsed = await runtime.runParse(input, { onStage: setParseStage })
				setSelectedCandidateIndex(0)
				setResult(parsed)
			} catch (error) {
				setParseError(error instanceof Error ? error.message : String(error))
			} finally {
				setBusy(false)
				setParseStage(-1)
			}
		},
		[runtime, text, busy]
	)

	const reset = useCallback(() => setResult(null), [])

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
