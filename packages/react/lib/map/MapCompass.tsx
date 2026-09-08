/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `<MapCompass>` — the needle that appears when the map leaves north and fades out when it returns.
 *
 *   It stays mounted through the fade rather than unmounting on the bearing crossing zero, because a control that
 *   vanishes mid-gesture is the thing that reads as a glitch. `HIDE_BELOW_DEGREES` is the dead zone: a map settled
 *   by a snap-to-north lands a fraction off zero, and a compass that lingers over that fraction never goes away.
 *
 *   Under `prefers-reduced-motion` it appears and disappears with no transition, and the needle still rotates —
 *   rotation IS the information, not decoration.
 *
 *   NODE-SAFE: pure React, no maplibre. The host reads the bearing off its own map and passes it in.
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
			// Out of the tab order and out of the accessibility tree while it is invisible, so a keyboard reaches only
			// the controls a pointer can see.
			aria-hidden={facingNorth}
			tabIndex={facingNorth ? -1 : 0}
			onClick={onResetNorth}
		>
			<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
				<g style={{ transform: `rotate(${-bearing}deg)`, transformOrigin: "12px 12px" }}>
					<path d="M12 3 L15.5 13 L12 11 L8.5 13 Z" fill="currentColor" />
					<path d="M12 21 L8.5 11 L12 13 L15.5 11 Z" fill="currentColor" opacity="0.35" />
				</g>
			</svg>
		</button>
	)
}
