/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Presentational search pill for map UIs. The host supplies the input and icons.
 *   Busy state uses a bottom-edge indicator to avoid changing the pill layout.
 */

import type { ReactNode } from "react"

import { cx } from "#common/cx"

/**
 * Draw a consistently sized magnifier for the leading slot.
 */
export function SearchGlyph(): ReactNode {
	return (
		<svg
			viewBox="0 0 20 20"
			width="18"
			height="18"
			aria-hidden="true"
			focusable="false"
			className="mw-map-searchbar__glyph"
		>
			<circle cx="8.75" cy="8.75" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
			<line x1="12.9" y1="12.9" x2="17" y2="17" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
		</svg>
	)
}

export interface MapSearchBarProps {
	/**
	 * The input (or combobox) the host owns.
	 *
	 * Rendered between the two slots.
	 */
	children: ReactNode
	/**
	 * Rendered before the input — a magnifier, a body mark, a back arrow.
	 */
	leading?: ReactNode
	/**
	 * Rendered after the input — a microphone, a menu.
	 *
	 * Not a spinner: pass {@link busy} instead.
	 */
	trailing?: ReactNode
	/**
	 * A query is running.
	 *
	 * Draws a progress hairline along the pill's lower edge, which takes no layout.
	 */
	busy?: boolean
	/**
	 * Extra class on the pill.
	 */
	className?: string
	/**
	 * Accessible name for the surrounding region, when the bar is the app's primary search.
	 */
	label?: string
}

export function MapSearchBar({ children, leading, trailing, busy, className, label }: MapSearchBarProps): ReactNode {
	return (
		<div
			className={cx("mw-map-searchbar", busy && "mw-map-searchbar--busy", className)}
			role={label ? "search" : undefined}
			aria-label={label}
			aria-busy={busy}
		>
			{leading ? <span className="mw-map-searchbar__slot mw-map-searchbar__slot--leading">{leading}</span> : null}

			<span className="mw-map-searchbar__field">{children}</span>

			{trailing ? <span className="mw-map-searchbar__slot mw-map-searchbar__slot--trailing">{trailing}</span> : null}
		</div>
	)
}
