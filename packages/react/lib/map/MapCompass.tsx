/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Shows a compass that rotates with the map bearing and hides when the map faces north. Pressing
 *   it asks the host to reset the bearing.
 */

import type { ReactNode } from "react"

import { cx } from "#common/cx"

/**
 * The compass counts as facing north, and fades out, below this many degrees of bearing.
 */
const HIDE_BELOW_DEGREES = 0.5

/**
 * Props for {@link MapCompass}.
 */
export interface MapCompassProps {
	/**
	 * The map's bearing in degrees as MapLibre reports it, where 0 is north.
	 */
	bearing: number
	/**
	 * Called when the compass is pressed.
	 * The host should reset its map to north.
	 */
	onResetNorth: () => void
	/**
	 * The control's accessible name. @default "Reset bearing to north"
	 */
	label?: string
	className?: string
}

/**
 * Renders the compass button.
 */
export function MapCompass({ bearing, onResetNorth, label, className }: MapCompassProps): ReactNode {
	const facingNorth = Math.abs(bearing) < HIDE_BELOW_DEGREES

	return (
		<button
			type="button"
			className={cx("mw-map-compass", facingNorth && "mw-map-compass--north", className)}
			aria-label={label ?? "Reset bearing to north"}
			title={label ?? "Reset bearing to north"}
			// The hidden compass leaves the tab order and the accessibility tree.
			aria-hidden={facingNorth}
			tabIndex={facingNorth ? -1 : 0}
			onClick={onResetNorth}
		>
			<svg viewBox="0 0 32 32" width="26" height="26" aria-hidden="true" focusable="false">
				<g style={{ transform: `rotate(${-bearing}deg)`, transformOrigin: "16px 16px" }}>
					<circle cx="16" cy="16" r="12.5" className="mw-map-compass__dial" />

					{/* The north needle, then the south needle. */}
					<path d="M16 5.5 L20.5 16 L16 16 Z M16 5.5 L11.5 16 L16 16 Z" className="mw-map-compass__north" />
					<path d="M16 26.5 L20.5 16 L16 16 Z M16 26.5 L11.5 16 L16 16 Z" className="mw-map-compass__south" />
				</g>
			</svg>
		</button>
	)
}
