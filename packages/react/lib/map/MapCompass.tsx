/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `<MapCompass>` — the needle that appears when the map leaves north and fades out when it returns.
 *
 *   It is a compass ROSE, the way the reference map apps draw it: a ringed dial carrying a two-tone needle whose red
 *   half points north and whose pale half points south. A single-color arrow cannot say which end is north, so a
 *   reader has to already know the convention to read it; two tones say it outright. There is no `N` on the dial —
 *   at this size the letter and the needle's north tip want the same few pixels, and the tip is the clearer of them.
 *
 *   The whole dial counter-rotates the bearing, so the needle keeps pointing at true north while the map turns under
 *   it. Pressing it returns the map to north, which is why the control is a button rather than an ornament.
 *
 *   It stays mounted through the fade rather than unmounting on the bearing crossing zero, because a control that
 *   vanishes mid-gesture is the thing that reads as a glitch. `HIDE_BELOW_DEGREES` is the dead zone: a map settled by
 *   a snap-to-north lands a fraction off zero, and a compass that lingers over that fraction never goes away.
 *
 *   Under `prefers-reduced-motion` it appears and disappears with no transition, and the dial still rotates —
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
			<svg viewBox="0 0 32 32" width="26" height="26" aria-hidden="true" focusable="false">
				<g style={{ transform: `rotate(${-bearing}deg)`, transformOrigin: "16px 16px" }}>
					<circle cx="16" cy="16" r="12.5" className="mw-map-compass__dial" />

					{/* North, then south. Two triangles meeting at the hub rather than one arrow through it. */}
					<path d="M16 5.5 L20.5 16 L16 16 Z M16 5.5 L11.5 16 L16 16 Z" className="mw-map-compass__north" />
					<path d="M16 26.5 L20.5 16 L16 16 Z M16 26.5 L11.5 16 L16 16 Z" className="mw-map-compass__south" />
				</g>
			</svg>
		</button>
	)
}
