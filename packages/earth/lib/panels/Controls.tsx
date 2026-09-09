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

export interface CalibrationToggleProps {
	checked: boolean
	onChange: (checked: boolean) => void
}

/**
 * The opt-in "Calibrated confidence" display toggle, as a sheet row.
 */
export const CalibrationToggle: React.FC<CalibrationToggleProps> = ({ checked, onChange }) => (
	<div className="mw-map-sheet__row">
		<label className="mw-map-sheet__check">
			<input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
			Calibrated confidence
		</label>

		<p className="mw-map-sheet__hint">
			{checked
				? "Each span's isotonic probability of being correct — held-out ECE 0.0055."
				: "Raw softmax scores. The model is under-confident, so most spans shift upward once calibrated."}
		</p>
	</div>
)

export interface DevModeToggleProps {
	checked: boolean
	onChange: (checked: boolean) => void
}

/**
 * The dev-mode toggle that opens the decode-path model-visualizer drawer, as a sheet row.
 */
export const DevModeToggle: React.FC<DevModeToggleProps> = ({ checked, onChange }) => (
	<div className="mw-map-sheet__row">
		<label className="mw-map-sheet__check">
			<input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
			Trace the decode path
		</label>

		<p className="mw-map-sheet__hint">
			Opens the model visualizer beside the map: tokens, retrieval channels, emissions, priors and repairs for the
			address in the field.
		</p>
	</div>
)
