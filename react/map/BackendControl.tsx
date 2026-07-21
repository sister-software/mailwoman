/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `<BackendControl>` — the neural-backend indicator + "Force WASM" checkbox from the demo's control
 *   panel (`_app.tsx:1255-1280`), as a dumb presentational unit. It shows which backend the runtime
 *   resolved to (WebGPU / WASM, with the int8 size the host formats into the label) and lets the visitor
 *   opt out of WebGPU. Props in, one boolean event out — the host re-loads the bundle on the toggle.
 *
 *   NODE-SAFE: pure React, no maplibre.
 */

import type { ReactNode } from "react"

export interface BackendControlProps {
	/** The backend the runtime resolved to (e.g. `webgpu (28 MB int8)`); empty before it is known. */
	activeBackend?: string
	/** Whether the CPU/WASM backend is currently forced. */
	forceWASM: boolean
	/** Fired when the visitor toggles the "Force WASM" checkbox. */
	onForceWASMChange: (forceWASM: boolean) => void
}

/** The backend indicator + WASM opt-out. */
export function BackendControl({ activeBackend, forceWASM, onForceWASMChange }: BackendControlProps): ReactNode {
	return (
		<div className="mw-demo-backend">
			{activeBackend ? (
				<span className="mw-demo-backend__active">
					Backend: <code>{activeBackend}</code>
				</span>
			) : null}
			<label className="mw-demo-backend__toggle">
				<input type="checkbox" checked={forceWASM} onChange={(e) => onForceWASMChange(e.target.checked)} /> Force WASM
			</label>
		</div>
	)
}
