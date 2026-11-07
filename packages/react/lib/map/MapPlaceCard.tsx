/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The card a map click opens: what the click landed on, its coordinate, and the two things to do with
 *   it, search it through the geocoder or copy the coordinate. A feature with a name is titled by that name,
 *   and bare ground by its coordinate.
 */

import { coordinatePairText } from "@mailwoman/spatial/point-query"
import type { ReactNode } from "react"

import { cx } from "#common/cx"
import type { MapPick } from "#map/useMapPick"

import { CopyButton } from "../common/CopyButton.tsx"
import { SheetClose } from "./MapSheet.tsx"

export interface MapPlaceCardProps {
	pick: MapPick
	/**
	 * Search the card's subject: the feature's name, or the coordinate for bare ground.
	 */
	onSearch: (query: string) => void
	onClose: () => void
	className?: string
}

/**
 * The query the card searches: a name when the click had one, else the coordinate pair.
 */
export function pickQuery(pick: MapPick): string {
	const [lon, lat] = pick.lngLat

	return pick.name ?? coordinatePairText(lat, lon)
}

export function MapPlaceCard({ pick, onSearch, onClose, className }: MapPlaceCardProps): ReactNode {
	const [lon, lat] = pick.lngLat
	const coordinates = coordinatePairText(lat, lon)
	const title = pick.name ?? coordinates

	return (
		<aside className={cx("mw-map-card", className)} aria-label="Clicked place">
			<div className="mw-map-card__body">
				<h2 className="mw-map-card__title">{title}</h2>
				<p className="mw-map-card__line">
					{pick.placetype ? <span className="mw-map-card__kind">{pick.placetype}</span> : null}
					{pick.name ? <code className="mw-map-card__coords">{coordinates}</code> : null}
				</p>
			</div>

			<div className="mw-map-card__actions">
				<button type="button" className="mw-map-chip" onClick={() => onSearch(pickQuery(pick))}>
					Search
				</button>
				<CopyButton value={coordinates} label="Copy coordinates" copiedLabel="Copied" className="mw-map-chip" />
			</div>

			<SheetClose label="Close the place card" onClose={onClose} />
		</aside>
	)
}
