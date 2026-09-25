/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Earth's footer strip, in one place.
 *
 *   The app mounts two runtimes — the real one, and the canned one `?runtime=fake` serves the shell smoke and the
 *   stories — and both render this component rather than each building its own `<MapFooter>`. The deployed page is the
 *   real one, so anything the fake path alone carries renders nowhere a visitor can see, and a smoke reading the fake
 *   footer then attests something that does not ship. `status` is the only thing the two paths may differ by.
 */

import { AppIdentity } from "@mailwoman/react/map/AppIdentity"
import { MapFooter } from "@mailwoman/react/map/MapFooter"
import { commitURL } from "@mailwoman/site-kit/build-info"
import { DATA_CREDITS } from "mailwoman/browser-runtime/resources"
import type { ReactNode } from "react"

/**
 * The sources Earth draws, each a licence obligation rather than a courtesy — so each one links to the licence it discharges. Three bare strings were the weakest form this could take: ODbL asks for attribution a reader can follow back, and "© OpenStreetMap" with nowhere to go does not give them that. The OSM entry also names contributors, which is who the copyright belongs to.
 */
/**
 * The basemap's own credits, which belong to whoever renders the tiles.
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
 * The basemap's credits, then one per publisher behind the rows a result is resolved against.
 *
 * The footer credited the tiles alone.
 * A result shown here is resolved against the admin gazetteer, the POI layer and the street extracts,
 * whose publishers attach attribution conditions to exactly this display, and none of them was named.
 *
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
	 * What is loading right now, beside the identity.
	 *
	 * The bar across the top of the viewport says how far along it is.
	 * This says which artifact it is fetching, which is the part a number cannot carry.
	 * Absent on the canned runtime, which loads no artifact.
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
