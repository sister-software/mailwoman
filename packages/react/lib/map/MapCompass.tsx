/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Show a counter-rotating compass when the map is not facing north.
 *   Pressing the button resets the map; the host supplies its bearing.
 */

import type { ReactNode } from "react"

import { cx } from "#common/cx"

/**
 * Below this many degrees off north the compass is treated as pointing north and fades out.
 */
const HIDE_BELOW_DEGREES = 0.5

export interface MapCompassProps {
	/**
	 * The map's bearing in degrees, as MapLibre reports it: 0 is north, positive is counter-clockwise.
	 */
	bearing: number
	/**
	 * Fired when the compass is pressed — the host resets its map to north.
	 */
	onResetNorth: () => void
	/**
	 * The control's accessible name. @default "Reset bearing to north"
	 */
	label?: string
	className?: string
}

export function MapCompass({ bearing, onResetNorth, label, className }: MapCompassProps): ReactNode {
	const facingNorth = Math.abs(bearing) < HIDE_BELOW_DEGREES

	return (
		<button
			type="button"
			className={cx("mw-map-compass", facingNorth && "mw-map-compass--north", className)}
			aria-label={label ?? "Reset bearing to north"}
			title={label ?? "Reset bearing to north"}
			// Out of the tab order and out of the accessibility tree while it is invisible,
			// so a keyboard reaches only the controls a pointer can see.
			aria-hidden={facingNorth}
			tabIndex={facingNorth ? -1 : 0}
			onClick={onResetNorth}
		>
			<svg viewBox="0 0 32 32" width="26" height="26" aria-hidden="true" focusable="false">
				<g style={{ transform: `rotate(${-bearing}deg)`, transformOrigin: "16px 16px" }}>
					<circle cx="16" cy="16" r="12.5" className="mw-map-compass__dial" />

					{/*
					 * North, then south.
					 *
					 * Two triangles meeting at the hub rather than one arrow through it.
					 */}
					<path d="M16 5.5 L20.5 16 L16 16 Z M16 5.5 L11.5 16 L16 16 Z" className="mw-map-compass__north" />
					<path d="M16 26.5 L20.5 16 L16 16 Z M16 26.5 L11.5 16 L16 16 Z" className="mw-map-compass__south" />
				</g>
			</svg>
		</button>
	)
}
