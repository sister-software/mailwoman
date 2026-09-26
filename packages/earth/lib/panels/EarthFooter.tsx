/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The deployed page is the real runtime, so anything the fake path alone carries renders nowhere a visitor can see; `status` is the only thing the two paths may differ by.
 */

import { AppIdentity } from "@mailwoman/react/map/AppIdentity"
import { MapFooter } from "@mailwoman/react/map/MapFooter"
import { commitURL } from "@mailwoman/site-kit/build-info"
import { DATA_CREDITS } from "mailwoman/browser-runtime/resources"
import type { ReactNode } from "react"

/**
 * The basemap's credits belong to whoever renders the tiles; each source is a licence
 * obligation rather than a courtesy, so it links to the licence it discharges.
 */
const BASEMAP_ATTRIBUTION = [
	<a key="osm" href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">
		© OpenStreetMap contributors
	</a>,
	<a key="protomaps" href="https://protomaps.com" target="_blank" rel="noreferrer">
		Protomaps
	</a>,
	<a key="maplibre" href="https://maplibre.org" target="_blank" rel="noreferrer">
		MapLibre
	</a>,
]

/**
 * `DATA_CREDITS` is read from the runtime that fetches those objects, so a surface that
 * stops loading one stops crediting it without anybody editing this file.
 */
const ATTRIBUTION = [
	...BASEMAP_ATTRIBUTION,
	...DATA_CREDITS.map((credit) => (
		<a key={credit.publisher} href={credit.termsURL} target="_blank" rel="noreferrer">
			{credit.publisher}
		</a>
	)),
]

export interface EarthFooterProps {
	/**
	 * Which artifact is loading, since the progress bar only says how far along;
	 * absent on the canned runtime, which loads no artifact.
	 */
	status?: ReactNode
}

export function EarthFooter({ status }: EarthFooterProps): ReactNode {
	return (
		<MapFooter
			identity={<AppIdentity name="Mailwoman Earth" docsURL="https://mailwoman.ai/docs" commitHref={commitURL} />}
			status={status}
			attribution={ATTRIBUTION}
		/>
	)
}
