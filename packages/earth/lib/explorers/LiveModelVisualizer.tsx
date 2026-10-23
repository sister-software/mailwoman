/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The trace workbench. A wide text field at the top center takes an address, a pasted postal block with
 *   its newlines included. Under it, three columns: the tiles for permuting the words, the bands for the
 *   current text, and the readings. The text is traced as it is typed, after a short debounce, and a trace
 *   that arrives after a newer one started is dropped, so the bands never show a reading of text the visitor
 *   has since changed. The traced text is written to the URL's `q` so a reload or a shared link keeps it.
 *
 *   A classifier bundle that predates the trace hook reports that fact instead of rendering an empty workbench.
 */

import type { ParseTraceLike } from "mailwoman/browser-runtime/types"
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { CharacterBand } from "./ModelVisualizer/CharacterBand.tsx"
import { flipsAfterRemoval, type LabelFlip, moveTile, tilesOf } from "./ModelVisualizer/helpers.ts"
import { ModelVisualizer } from "./ModelVisualizer/ModelVisualizer.tsx"
import { ReadingsPanel } from "./ModelVisualizer/ReadingsPanel.tsx"
import { TileBoard } from "./ModelVisualizer/TileBoard.tsx"

import styles from "./ModelVisualizer/styles.module.css"

const DEFAULT_TEXT = "1600 Pennsylvania Ave NW, Washington, DC 20500"

/**
 * How long the input rests before a keystroke's trace runs.
 *
 * A trace costs about 60 ms on the preview, so the debounce is the larger share of the lag a typist sees.
 */
const DEBOUNCE_MS = 120

export interface LiveModelVisualizerProps {
	/**
	 * Trace an input through the decode path, resolving null when the classifier
	 * is not ready or the trace fails.
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
	/**
	 * The text to trace first, from the URL, in place of the default address.
	 */
	initialText?: string | null
	/**
	 * Called with each text that was traced, so the page can keep the URL in step.
	 */
	onTextTraced?: (text: string) => void
}

export function LiveModelVisualizer({
	traceParse,
	supportsTrace,
	ready,
	loadingProgress,
	errorMessage,
	initialText,
	onTextTraced,
}: LiveModelVisualizerProps): React.JSX.Element {
	const [text, setText] = useState(initialText ?? DEFAULT_TEXT)
	const [trace, setTrace] = useState<ParseTraceLike | null>(null)
	const [pending, setPending] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [lastMs, setLastMs] = useState<number | null>(null)

	// The last text typed into the field.
	// The tile board's reset restores it.
	const typed = useRef(text)

	// The sequence guard: each trace takes a number when it starts, and only the newest number may publish.
	const sequence = useRef(0)

	const tiles = useMemo(() => tilesOf(text), [text])
	const [probe, setProbe] = useState<{ text: string; flips: LabelFlip[][] } | null>(null)
	const [probing, setProbing] = useState(false)

	const run = useCallback(
		async (input: string) => {
			const mine = ++sequence.current

			setPending(true)
			setError(null)

			const started = performance.now()

			try {
				const result = await traceParse(input)

				if (mine !== sequence.current) return

				setTrace(result)
				setLastMs(Math.round(performance.now() - started))
				onTextTraced?.(input)
			} catch (caught) {
				if (mine !== sequence.current) return

				// ORT's wasm backend can throw non-Errors (abort codes as numbers or strings),
				// so `String()` keeps the failure visible instead of storing undefined.
				setError(caught instanceof Error ? caught.message : String(caught))
			} finally {
				if (mine === sequence.current) {
					setPending(false)
				}
			}
		},
		[traceParse, onTextTraced]
	)

	// Trace as the text changes, after the debounce, once the classifier is usable.
	useEffect(() => {
		if (!ready || !supportsTrace) return

		const timer = setTimeout(() => void run(text), DEBOUNCE_MS)

		return () => clearTimeout(timer)
	}, [ready, supportsTrace, run, text])

	// One trace per tile with that tile removed, compared against a trace of the tiles joined by spaces.
	const probeTiles = useCallback(async () => {
		const base = tiles.join(" ")

		setProbing(true)

		try {
			const baseTrace = await traceParse(base)

			if (!baseTrace) return

			const flips: LabelFlip[][] = []
			let offset = 0

			for (let index = 0; index < tiles.length; index++) {
				const tile = tiles[index]!
				const removed = tiles.filter((_, other) => other !== index).join(" ")
				const probeTrace = await traceParse(removed)

				flips.push(probeTrace ? flipsAfterRemoval(baseTrace.tokens, probeTrace.tokens, offset, tile.length + 1) : [])
				offset += tile.length + 1
			}

			setProbe({ text: base, flips })
		} finally {
			setProbing(false)
		}
	}, [tiles, traceParse])

	if (errorMessage) return <p role="alert">Asset loading failed: {errorMessage}</p>

	if (!ready) return <p>Loading model assets… {loadingProgress}</p>

	if (!supportsTrace) {
		return <p>This deployed model bundle predates the `traceParse` hook — trace introspection unavailable.</p>
	}

	const lines = 1 + (text.match(/\n/gu)?.length ?? 0)

	return (
		<div className={styles.workbench}>
			<form
				className={styles.traceForm}
				onSubmit={(event) => {
					event.preventDefault()
					void run(text)
				}}
			>
				<h1 className={styles.traceTitle}>Trace the decode path</h1>
				<textarea
					className={styles.traceInput}
					value={text}
					rows={Math.max(2, Math.min(8, lines))}
					onChange={(event) => {
						typed.current = event.target.value
						setText(event.target.value)
					}}
					aria-label="Address to trace"
					spellCheck={false}
				/>
				<div className={styles.traceMeta}>
					<p className={styles.traceHint}>
						Type or paste an address, newlines included. Each change is traced, and the bands and readings follow.
					</p>
					<p className={styles.traceStatus} aria-live="polite">
						{lastMs === null ? "No trace yet." : `Last trace ${lastMs} ms.`}
					</p>
					<button type="submit" className={styles.traceButton} disabled={pending}>
						{pending ? "Tracing…" : "Trace"}
					</button>
				</div>
				{error ? (
					<p className="mw-error" role="alert">
						{error}
					</p>
				) : null}
			</form>

			<div className={styles.columns}>
				<aside className={styles.column} aria-label="Permutations">
					<h4 className={styles.bandTitle}>Tiles</h4>
					<p className={styles.readingHint}>
						Drag a word to a new place or remove it. The probe traces the text once per tile with that tile removed and
						lists the labels that changed elsewhere.
					</p>
					<TileBoard
						tiles={tiles}
						flips={probe && probe.text === tiles.join(" ") ? probe.flips : null}
						probing={probing}
						onMove={(from, to) => setText(moveTile(tiles, from, to).join(" "))}
						onRemove={(index) => setText(tiles.filter((_, other) => other !== index).join(" "))}
						onReset={() => setText(typed.current)}
						onProbe={() => void probeTiles()}
					/>
				</aside>

				<section className={styles.column} aria-label="Bands">
					{trace ? (
						<>
							<h4 className={styles.bandTitle}>0 · Characters</h4>
							<CharacterBand text={trace.text} tokens={trace.tokens} labels={trace.labels} />
							<ModelVisualizer trace={trace} />
						</>
					) : null}
				</section>

				<aside className={styles.column} aria-label="Readings">
					{trace ? <ReadingsPanel trace={trace} /> : null}
				</aside>
			</div>
		</div>
	)
}
