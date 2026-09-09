/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The `/trace` route: an input, a trace button, and the four-band model visualizer over the loaded classifier's
 *   decode-path trace. The runtime handle supplies the trace hook; a classifier bundle that predates it says so
 *   instead of rendering an empty visualizer.
 */

import type { ParseTraceLike } from "mailwoman/browser-runtime/types"
import React, { useCallback, useState } from "react"

import { ModelVisualizer } from "./ModelVisualizer/ModelVisualizer.tsx"

import styles from "./ModelVisualizer/styles.module.css"

const DEFAULT_TEXT = "1600 Pennsylvania Ave NW, Washington, DC 20500"

export interface LiveModelVisualizerProps {
	/**
	 * Trace an input through the decode path. Resolves null when the classifier is not ready or the trace fails.
	 */
	traceParse: (input: string) => Promise<ParseTraceLike | null>
	/**
	 * Whether the loaded classifier exposes the trace hook.
	 */
	supportsTrace: boolean
	/**
	 * Whether the runtime has finished loading a release.
	 */
	ready: boolean
	/**
	 * The loader's progress line while `ready` is false.
	 */
	loadingProgress: string | null
	/**
	 * The loader's terminal error, if loading failed.
	 */
	errorMessage: string | null
}

export function LiveModelVisualizer({
	traceParse,
	supportsTrace,
	ready,
	loadingProgress,
	errorMessage,
}: LiveModelVisualizerProps): React.JSX.Element {
	const [text, setText] = useState(DEFAULT_TEXT)
	const [trace, setTrace] = useState<ParseTraceLike | null>(null)
	const [pending, setPending] = useState(false)
	const [error, setError] = useState<string | null>(null)

	const run = useCallback(async () => {
		setPending(true)
		setError(null)

		try {
			setTrace(await traceParse(text))
		} catch (caught) {
			// ORT's WASM backend can throw non-Errors (abort codes as numbers or strings); String() keeps the failure
			// visible instead of storing undefined and rendering nothing.
			setError(caught instanceof Error ? caught.message : String(caught))
		} finally {
			setPending(false)
		}
	}, [traceParse, text])

	if (errorMessage) return <p role="alert">Asset loading failed: {errorMessage}</p>

	if (!ready) return <p>Loading model assets… {loadingProgress}</p>

	if (!supportsTrace) {
		return <p>This deployed model bundle predates the `traceParse` hook — trace introspection unavailable.</p>
	}

	return (
		<div className={styles.root}>
			<h1 className={styles.traceTitle}>Trace the decode path</h1>

			<p className={styles.traceHint}>
				Run an address through the classifier and read the four bands it produced: tokens, retrieval channels, emissions
				and repairs.
			</p>

			<form
				className={styles.traceForm}
				onSubmit={(event) => {
					event.preventDefault()
					void run()
				}}
			>
				<input
					type="text"
					className={styles.traceInput}
					value={text}
					onChange={(event) => setText(event.target.value)}
					aria-label="Address to trace"
				/>
				<button type="submit" className={styles.traceButton} disabled={pending}>
					{pending ? "Tracing…" : "Trace"}
				</button>
			</form>

			{error ? (
				<p className="mw-error" role="alert">
					{error}
				</p>
			) : null}
			{trace ? <ModelVisualizer trace={trace} /> : null}
		</div>
	)
}
