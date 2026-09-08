/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `<MapSearchBar>` — the floating search pill that sits over a map. Presentational only: it supplies the glass
 *   material, the pill shape and the two icon slots, and the host supplies the input and whatever backend answers it.
 *   Earth searches an address through the geocoder runtime and the planetary apps search a nomenclature artifact, so
 *   nothing about the query belongs here.
 *
 *   The slots are elements rather than icon names because a leading mark and a trailing control differ per app — a
 *   magnifier and a clear button on one, a body glyph and nothing on another.
 *
 *   NODE-SAFE: pure React, no maplibre.
 */

import type { ReactNode } from "react"

import { cx } from "#common/cx"

export interface MapSearchBarProps {
	/**
	 * The input (or combobox) the host owns. Rendered between the two slots.
	 */
	children: ReactNode
	/**
	 * Rendered before the input — a magnifier, a body mark, a back arrow.
	 */
	leading?: ReactNode
	/**
	 * Rendered after the input — a clear button, a microphone, a spinner.
	 */
	trailing?: ReactNode
	/**
	 * Extra class on the pill.
	 */
	className?: string
	/**
	 * Accessible name for the surrounding region, when the bar is the app's primary search.
	 */
	label?: string
}

export function MapSearchBar({ children, leading, trailing, className, label }: MapSearchBarProps): ReactNode {
	return (
		<div className={cx("mw-map-searchbar", className)} role={label ? "search" : undefined} aria-label={label}>
			{leading ? <span className="mw-map-searchbar__slot mw-map-searchbar__slot--leading">{leading}</span> : null}

			<span className="mw-map-searchbar__field">{children}</span>

			{trailing ? <span className="mw-map-searchbar__slot mw-map-searchbar__slot--trailing">{trailing}</span> : null}
		</div>
	)
}
