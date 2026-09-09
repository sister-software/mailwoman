/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Host control widgets injected into the geocoder via the `GeocoderPanels` injection point: the device-location
 *   proximity-bias row (`panels.bias`) and the two opt-in display toggles (`panels.aboveResult`) — calibrated
 *   confidence + dev mode. Host-owned because the state they carry (geolocation permission, the calibrated view, the
 *   dev-mode drawer) is a host concern, not a package one.
 */

import type React from "react"

export interface GeoBiasRowProps {
	/**
	 * Whether a device location is currently applied as a bias.
	 */
	active: boolean
	/**
	 * Toggle the device-location bias.
	 */
	onToggle: () => void
}

/**
 * The device-location bias, as one chip in the map chrome.
 *
 * The explanation rides the button's title rather than the map surface: prose laid over a map reads as a caption on the
 * world beneath it, and the chip's pressed state already says whether the hint is on.
 */
export const GeoBiasRow: React.FC<GeoBiasRowProps> = ({ active, onToggle }) => (
	<div className="mw-map-chiprow">
		<button
			type="button"
			className="mw-map-chip"
			aria-pressed={active}
			title="Add your device location as a soft proximity hint, in addition to the map view. Never a filter — a strong population signal still wins."
			onClick={onToggle}
		>
			{active ? "Using your location" : "Use my location"}
		</button>
	</div>
)

const TOGGLE_STYLE: React.CSSProperties = {
	display: "inline-flex",
	alignItems: "center",
	gap: 6,
	fontSize: 13,
	margin: "8px 0",
	cursor: "pointer",
	color: "var(--ifm-color-emphasis-800)",
}

export interface CalibrationToggleProps {
	checked: boolean
	onChange: (checked: boolean) => void
}

/**
 * The opt-in "Calibrated confidence" display toggle. Mirrors `_app.tsx`.
 */
export const CalibrationToggle: React.FC<CalibrationToggleProps> = ({ checked, onChange }) => (
	<label
		style={TOGGLE_STYLE}
		title="Map each span's raw softmax confidence to its calibrated probability of being correct (isotonic, held-out ECE 0.0055). The model is under-confident, so most spans shift upward."
	>
		<input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
		Calibrated confidence
		<span style={{ color: "var(--ifm-color-emphasis-600)" }}>
			{checked ? "— honest probability of correct" : "— raw softmax scores"}
		</span>
	</label>
)

export interface DevModeToggleProps {
	checked: boolean
	onChange: (checked: boolean) => void
}

/**
 * The "🐛 Dev mode" toggle that opens the decode-path model-visualizer drawer. Mirrors `_app.tsx`.
 */
export const DevModeToggle: React.FC<DevModeToggleProps> = ({ checked, onChange }) => (
	<label
		style={TOGGLE_STYLE}
		title="Open the model-visualizer drawer: trace this address through the decode path — tokens, retrieval channels, emissions, priors, repairs — beside the map."
	>
		<input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />🐛 Dev mode
		<span style={{ color: "var(--ifm-color-emphasis-600)" }}>— trace the decode path</span>
	</label>
)
