/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Host control widgets injected into the geocoder via the `GeocoderPanels` injection point: the device-location
 *   proximity-bias row (`panels.bias`) and the two opt-in display toggles (`panels.aboveResult`) — calibrated
 *   confidence + dev mode. Host-owned because the state they carry (geolocation permission, the calibrated view, the
 *   dev-mode drawer) is a host concern rather than a package one.
 */

import type React from "react"

import type { GeoBiasError } from "#runtime/use/geo-bias"

import styles from "./panels.module.css"

/**
 * What each failure says.
 *
 * Short enough to sit beside the chip, and each one tells the visitor what to do next
 * rather than restating that something went wrong.
 */
const GEO_BIAS_MESSAGE: Record<GeoBiasError, string> = {
	denied: "Location is blocked for this site — allow it in your browser's site settings, then press again.",
	unavailable: "Your device could not get a location right now. The map view is still biasing results.",
	unsupported: "This browser does not offer a device location. The map view is still biasing results.",
}

export interface GeoBiasRowProps {
	/**
	 * Whether a device location is currently applied as a bias.
	 */
	active: boolean
	/**
	 * Why the last attempt failed, or `null`.
	 */
	error: GeoBiasError | null
	/**
	 * Toggle the device-location bias.
	 */
	onToggle: () => void
}

/**
 * The device-location bias, as one chip in the map chrome.
 *
 * The chip's own row is not `.mw-map-chiprow`: that class carries an overflow-scroll
 * and an edge-fade mask built for a dozen example chips, and inheriting it here
 * faded the right edge of a single button for no reason.
 *
 * A failure gets a line of its own.
 * The pressed state cannot carry it.
 *
 * A denial turns the chip back off, which looks identical to the visitor turning it off,
 * and the browser will not prompt a second time.
 *
 * Therefore, pressing again appeared to have no effect at all.
 */
export const GeoBiasRow: React.FC<GeoBiasRowProps> = ({ active, error, onToggle }) => (
	<div className={styles.biasRow}>
		<button
			type="button"
			className="mw-map-chip"
			aria-pressed={active}
			title="Add your device location as a soft proximity hint, in addition to the map view. Never a filter — a strong population signal still wins."
			onClick={onToggle}
		>
			{active ? "Using your location" : "Use my location"}
		</button>

		{error ? (
			<p className={styles.biasError} role="status">
				{GEO_BIAS_MESSAGE[error]}
			</p>
		) : null}
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
