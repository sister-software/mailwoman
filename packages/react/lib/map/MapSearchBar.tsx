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
 *   magnifier on one, a body glyph on another.
 *
 *   BUSY IS A LINE, NOT A SLOT. A spinner placed in the trailing slot changed the pill's height on every submit,
 *   because a slot is laid out and an indicator is not part of the query. `busy` draws a hairline across the pill's
 *   lower edge instead, which costs no layout. A host that wants `type="search"` also gets the browser's own clear
 *   button in that corner, and two crosses side by side is one control too many.
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
	 * Rendered after the input — a microphone, a menu. Not a spinner: pass {@link busy} instead.
	 */
	trailing?: ReactNode
	/**
	 * A query is running. Draws a progress hairline along the pill's lower edge, which takes no layout.
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
