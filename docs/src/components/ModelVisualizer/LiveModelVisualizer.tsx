/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Live wrapper for <ModelVisualizer>: an input box + the demo-embed classifier (production
 *   Hugging Face assets via DemoEmbedProvider). Feature-detects `traceParse` — deployed bundles
 *   built before the trace seam lack it, in which case we say so instead of crashing.
 */

import React, { useCallback, useState } from "react"

import { useDemoEmbed } from "../../contexts/DemoEmbed.tsx"
import type { ParseTraceLike } from "../../shared/resources.tsx"
import { ModelVisualizer } from "./ModelVisualizer.tsx"

import styles from "./styles.module.css"

const DEFAULT_TEXT = "1600 Pennsylvania Ave NW, Washington, DC 20500"

export function LiveModelVisualizer(): React.JSX.Element {
	const { classifier, ready, loadingProgress, errorMessage } = useDemoEmbed()
	const [text, setText] = useState(DEFAULT_TEXT)
	const [trace, setTrace] = useState<ParseTraceLike | null>(null)
	const [pending, setPending] = useState(false)
	const [error, setError] = useState<string | null>(null)

	const run = useCallback(async () => {
		if (!classifier?.traceParse) return
		setPending(true)
		setError(null)

		try {
			setTrace(await classifier.traceParse(text, { addressSystemConventions: "auto" }))
		} catch (err) {
			setError((err as Error).message)
		} finally {
			setPending(false)
		}
	}, [classifier, text])

	if (errorMessage) return <p role="alert">Asset loading failed: {errorMessage}</p>

	if (!ready) return <p>Loading model assets… {loadingProgress}</p>

	if (!classifier?.traceParse) {
		return <p>This deployed model bundle predates the trace seam — trace introspection unavailable.</p>
	}

	return (
		<div className={styles.root}>
			<form
				onSubmit={(e) => {
					e.preventDefault()
					void run()
				}}
			>
				<input
					type="text"
					value={text}
					onChange={(e) => setText(e.target.value)}
					size={60}
					aria-label="Address to trace"
				/>
				<button type="submit" disabled={pending}>
					{pending ? "Tracing…" : "Trace"}
				</button>
			</form>
			{error ? <p role="alert">{error}</p> : null}
			{trace ? <ModelVisualizer trace={trace} /> : null}
		</div>
	)
}
