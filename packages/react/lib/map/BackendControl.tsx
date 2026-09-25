/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Show the active inference backend and let visitors force WASM.
 *   The host handles backend changes; this component is presentational.
 */

import type { ReactNode } from "react"

export interface BackendControlProps {
	/**
	 * The backend the runtime resolved to (e.g. `webgpu (28 MB int8)`); empty before it is known.
	 */
	activeBackend?: string
	/**
	 * Whether the CPU/wasm backend is currently forced.
	 */
	forceWASM: boolean
	/**
	 * Fired when the visitor toggles the "Force wasm" checkbox.
	 */
	onForceWASMChange: (forceWASM: boolean) => void
}

/**
 * The backend indicator + wasm opt-out.
 */
export function BackendControl({ activeBackend, forceWASM, onForceWASMChange }: BackendControlProps): ReactNode {
	return (
		<div className="mw-demo-backend">
			<span className="mw-map-sheet__label">Inference backend</span>

			{activeBackend ? (
				<span className="mw-demo-backend__active">
					Running on <code>{activeBackend}</code>
				</span>
			) : null}

			<label className="mw-map-sheet__check mw-demo-backend__toggle">
				<input type="checkbox" checked={forceWASM} onChange={(event) => onForceWASMChange(event.target.checked)} />
				Force WASM
			</label>
		</div>
	)
}
