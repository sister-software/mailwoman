/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `<MapSheet>` — a side panel over the map: a title, a close button, and content.
 *
 *   The close button is not optional. On a wide screen the control that opened the sheet stays visible beside it and
 *   could close it again, but on a phone the sheet is the whole panel and covers that control — so a sheet without its
 *   own close is a sheet a phone cannot dismiss. One component carries it so the four sheets in these apps cannot
 *   disagree about that.
 *
 *   Escape closes it too, because a panel over the whole screen is a modal in every way that matters to someone
 *   holding a keyboard.
 *
 *   NODE-SAFE: pure React, no maplibre.
 */

import { type ReactNode, useEffect } from "react"

import { cx } from "#common/cx"

export interface MapSheetProps {
	/**
	 * The sheet's heading, and its accessible name.
	 */
	title: string
	/**
	 * Dismiss the sheet.
	 */
	onClose: () => void
	children: ReactNode
	className?: string
}

export function MapSheet({ title, onClose, children, className }: MapSheetProps): ReactNode {
	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				onClose()
			}
		}

		document.addEventListener("keydown", onKeyDown)

		return () => document.removeEventListener("keydown", onKeyDown)
	}, [onClose])

	return (
		<aside className={cx("mw-map-sheet mw-map-sheet--side", className)} aria-label={title}>
			<div className="mw-map-sheet__header">
				<h2 className="mw-map-sheet__title">{title}</h2>

				<button type="button" className="mw-map-sheet__close" aria-label={`Close ${title}`} onClick={onClose}>
					<span aria-hidden="true">×</span>
				</button>
			</div>

			<div className="mw-map-sheet__body">{children}</div>
		</aside>
	)
}
