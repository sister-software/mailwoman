/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `<MapFooter>` — the strip along the bottom of a map: identity and load status on the left, an attribution button
 *   on the right.
 *
 *   Attribution is a licence obligation for every source these apps draw, so it is a first-class slot rather than
 *   something an app remembers to add. It sits behind a button because the strip has to stay ONE line: spelled out, the
 *   credits ran three lines deep on a phone and covered the sheet above them. The button names the obligation, and
 *   pressing it shows every credit — which is the treatment the reference map apps use.
 *
 *   The status slot is where the loader says WHAT it is fetching while the bar at the top of the viewport says how far
 *   along it is.
 *
 *   NODE-SAFE: pure React, no maplibre.
 */

import { type ReactNode, useEffect, useId, useRef, useState } from "react"

import { cx } from "#common/cx"

export interface MapFooterProps {
	/**
	 * The left side: a wordmark, a body name, a line saying what the page does.
	 */
	identity?: ReactNode
	/**
	 * Beside the identity: what is loading right now. Absent when nothing is.
	 */
	status?: ReactNode
	/**
	 * The credits, one entry per source. Shown in the popover the attribution button opens.
	 */
	attribution?: ReactNode[]
	/**
	 * What the attribution button reads. @default "Sources"
	 */
	attributionLabel?: string
	className?: string
}

export function MapFooter({
	identity,
	status,
	attribution,
	attributionLabel = "Sources",
	className,
}: MapFooterProps): ReactNode {
	const [open, setOpen] = useState(false)
	const popoverID = useId()
	const root = useRef<HTMLElement>(null)

	// A popover closes when the conversation moves elsewhere: a press outside it, or Escape.
	useEffect(() => {
		if (!open) return

		const onPointerDown = (event: PointerEvent) => {
			if (!root.current?.contains(event.target as Node)) {
				setOpen(false)
			}
		}

		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				setOpen(false)
			}
		}

		document.addEventListener("pointerdown", onPointerDown)
		document.addEventListener("keydown", onKeyDown)

		return () => {
			document.removeEventListener("pointerdown", onPointerDown)
			document.removeEventListener("keydown", onKeyDown)
		}
	}, [open])

	if (!identity && !status && !attribution?.length) return null

	return (
		<footer className={cx("mw-map-footer", className)} ref={root}>
			<div className="mw-map-footer__identity">
				{identity}
				{status ? <span className="mw-map-footer__status">{status}</span> : null}
			</div>

			{attribution?.length ? (
				<div className="mw-map-footer__sources">
					{open ? (
						<div className="mw-map-footer__popover" id={popoverID} role="group" aria-label="Map data sources">
							{attribution.map((entry, index) => (
								// The entries are a fixed, ordered credit list that never reorders, so position is the identity.
								<span key={index} className="mw-map-footer__credit">
									{entry}
								</span>
							))}
						</div>
					) : null}

					<button
						type="button"
						className="mw-map-footer__attribution-button"
						aria-expanded={open}
						aria-controls={open ? popoverID : undefined}
						onClick={() => setOpen((value) => !value)}
					>
						{attributionLabel}
					</button>
				</div>
			) : null}
		</footer>
	)
}
