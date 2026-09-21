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
 *   node-safe: pure React, no maplibre.
 */

import { type ReactNode, useEffect } from "react"

import { cx } from "#common/cx"

export interface SheetCloseProps {
	/**
	 * What is being closed, for the accessible name: "Close the result", "Close About".
	 */
	label: string
	onClose: () => void
	className?: string
}

/**
 * The × that dismisses a sheet.
 *
 * Exported because the geocoder's panel needs the same control and had grown its own copy:
 * identical markup, the same borrowed class, a separately worded label.
 * One component so they cannot disagree about the glyph, the target or the fact that it is a `button`.
 */
export function SheetClose({ label, onClose, className }: SheetCloseProps): ReactNode {
	return (
		<button type="button" className={cx("mw-map-sheet__close", className)} aria-label={label} onClick={onClose}>
			<span aria-hidden="true">×</span>
		</button>
	)
}

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

				<SheetClose label={`Close ${title}`} onClose={onClose} />
			</div>

			<div className="mw-map-sheet__body">{children}</div>
		</aside>
	)
}
