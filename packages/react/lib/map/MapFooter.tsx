/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `<MapFooter>` — the strip along the bottom of a map carrying identity on one side and attribution on the other.
 *
 *   Attribution is a licence obligation for every source these apps draw, so it is a first-class slot rather than
 *   something an app remembers to add. The strip clears the device's bottom safe-area inset, which matters because
 *   both apps install as PWAs and a home indicator otherwise sits on top of the credit.
 *
 *   NODE-SAFE: pure React, no maplibre.
 */

import type { ReactNode } from "react"

import { cx } from "#common/cx"

export interface MapFooterProps {
	/**
	 * The left side: a wordmark, a body name, a line saying what the page does.
	 */
	identity?: ReactNode
	/**
	 * The right side: source credits. Each entry is rendered as its own item, separated visually.
	 */
	attribution?: ReactNode[]
	className?: string
}

export function MapFooter({ identity, attribution, className }: MapFooterProps): ReactNode {
	if (!identity && !attribution?.length) return null

	return (
		<footer className={cx("mw-map-footer", className)}>
			{identity ? <div className="mw-map-footer__identity">{identity}</div> : null}

			{attribution?.length ? (
				<div className="mw-map-footer__attribution">
					{attribution.map((entry, index) => (
						// The entries are a fixed, ordered credit list rather than a keyed collection.
						// eslint-disable-next-line react/no-array-index-key
						<span key={index} className="mw-map-footer__credit">
							{entry}
						</span>
					))}
				</div>
			) : null}
		</footer>
	)
}
