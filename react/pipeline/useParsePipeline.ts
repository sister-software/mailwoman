/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `useParsePipeline` — the headless core of the pipeline explorer. Owns the query text, the
 *   busy/stage flags, the parse result, and the candidate selection; delegates the actual parse+resolve
 *   to the injected {@link PipelineRuntime}. No model or gazetteer code lives here — it just drives the
 *   contract and shapes the UI state.
 */

import { useCallback, useState } from "react"

import type { ParseResult, PipelineRuntime, ResolvedPlaceView } from "./types.ts"

export interface UseParsePipelineOptions {
	runtime: PipelineRuntime
	defaultText: string
}

export interface UseParsePipeline {
	text: string
	setText: (text: string) => void
	busy: boolean
	/** 0-based index into `runtime.parseStageLabels`; -1 when idle. */
	parseStage: number
	result: ParseResult | null
	parseError: string | null
	selectedCandidateIndex: number
	selectCandidate: (index: number) => void
	/** The currently-selected candidate (falls back to the first), or null. */
	selectedCandidate: ResolvedPlaceView | null
	/** Run a parse for the current text. Safe to bind to a form's `onSubmit`. */
	submit: () => Promise<void>
	/** Clear the result (used when a preset replaces the input). */
	reset: () => void
}

export function useParsePipeline({ runtime, defaultText }: UseParsePipelineOptions): UseParsePipeline {
	const [text, setText] = useState(defaultText)
	const [busy, setBusy] = useState(false)
	const [parseStage, setParseStage] = useState(-1)
	const [result, setResult] = useState<ParseResult | null>(null)
	const [selectedCandidateIndex, setSelectedCandidateIndex] = useState(0)
	const [parseError, setParseError] = useState<string | null>(null)

	const submit = useCallback(async () => {
		if (!runtime.ready || busy) return

		setBusy(true)
		setParseStage(0)
		setParseError(null)

		try {
			const parsed = await runtime.runParse(text, { onStage: setParseStage })
			setSelectedCandidateIndex(0)
			setResult(parsed)
		} catch (err) {
			setParseError(err instanceof Error ? err.message : String(err))
		} finally {
			setBusy(false)
			setParseStage(-1)
		}
	}, [runtime, text, busy])

	const reset = useCallback(() => setResult(null), [])

	// Derived during render — no effect needed.
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
