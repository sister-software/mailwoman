/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Side panel over the map with a heading, close button, and Escape dismissal.
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
 * Accessible button for dismissing a sheet.
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
