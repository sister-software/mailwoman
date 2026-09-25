/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Shows the active inference backend and a checkbox that forces WASM. The host applies the change.
 */

import type { ReactNode } from "react"

/**
 * Props for {@link BackendControl}.
 */
export interface BackendControlProps {
	/**
	 * The backend the runtime chose, such as `webgpu (28 MB int8)`.
	 * It is empty until known.
	 */
	activeBackend?: string
	/**
	 * Whether the WASM backend is forced.
	 */
	forceWASM: boolean
	/**
	 * Called when the visitor toggles the "Force WASM" checkbox.
	 */
	onForceWASMChange: (forceWASM: boolean) => void
}

/**
 * Renders the backend indicator and the "Force WASM" checkbox.
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
