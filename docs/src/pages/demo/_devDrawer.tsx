/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `<DemoDebugDrawer>` — the dev-mode decode-path drawer for `/demo`, injected into `<GeocoderDemo>`
 *   via `DemoPanels.debugDrawer`. It mirrors the live demo's model-visualizer aside (`_app.tsx`): when dev mode
 *   is on and a result is present, it traces the current input through the host's classifier and renders the
 *   docs `<ModelVisualizer>` beside the map. Dev-mode-gated by design — closed by default, opened by the
 *   "🐛 Dev mode" toggle.
 */

import type { ParseResult } from "@mailwoman/react"
import type React from "react"
import { useEffect, useState } from "react"

import { ModelVisualizer } from "../../components/ModelVisualizer/ModelVisualizer.tsx"
import type { ParseTraceLike } from "../../shared/resources.tsx"

import demoStyles from "./styles.module.css"

export interface DemoDebugDrawerProps {
	/** The current parse result (its input is re-traced when dev mode is on). */
	result: ParseResult | null
	/** Whether dev mode is on. */
	devMode: boolean
	/** Trace an input through the decode path (host's classifier). Resolves `null` when unavailable. */
	traceParse: (input: string) => Promise<ParseTraceLike | null>
	/** Close the drawer (flips dev mode off). */
	onClose: () => void
}

/** The model-visualizer drawer — mounts only in dev mode once a trace is ready. */
export const DemoDebugDrawer: React.FC<DemoDebugDrawerProps> = ({ result, devMode, traceParse, onClose }) => {
	const [trace, setTrace] = useState<ParseTraceLike | null>(null)
	const input = result?.input ?? null

	useEffect(() => {
		if (!devMode || !input) {
			setTrace(null)

			return
		}
		let cancelled = false

		void traceParse(input).then((t) => {
			if (!cancelled) {
				setTrace(t)
			}
		})

		return () => {
			cancelled = true
		}
	}, [devMode, input, traceParse])

	if (!devMode || !trace) return null

	return (
		<aside className={demoStyles.debugDrawer} aria-label="Model decode-path visualizer">
			<div className={demoStyles.debugDrawerHeader}>
				<strong>🐛 Decode path</strong>
				<button type="button" className={demoStyles.exampleBtn} onClick={onClose} aria-label="Close debug drawer">
					✕
				</button>
			</div>
			<ModelVisualizer trace={trace} />
		</aside>
	)
}
