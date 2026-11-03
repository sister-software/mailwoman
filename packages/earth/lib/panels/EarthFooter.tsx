/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The deployed page is the real runtime, so anything present only in the fake path renders nowhere a visitor can see; `status` is the only thing the two paths may differ by.
 */

import { AppIdentity } from "@mailwoman/react/map/AppIdentity"
import { MapFooter } from "@mailwoman/react/map/MapFooter"
import {
	Basemap,
	BASEMAP_INPUTS,
	CITY_MODEL_INPUTS,
	creditsFor,
	HILLSHADE_INPUTS,
} from "@mailwoman/structures/basemaps"
import { UNDERSEA_ATTRIBUTION } from "@mailwoman/undersea"
import { commitURL } from "@mailwoman/universe/site-kit/build-info"
import { DATA_CREDITS } from "mailwoman/browser-runtime/resources"
import type { ReactNode } from "react"

/**
 * The basemap the page loads.
 *
 * The configured planet and every `?basemap=` tileset are `mailwoman/basemaps` builds.
 */
const LOADED_BASEMAP = Basemap.MailwomanBuild

/**
 * The credits for every source the map draws from: the loaded basemap's inputs
 * and the hillshade's elevation tiles.
 *
 * The structure-source register holds each credit beside the license decision it discharges,
 * so a source added to a basemap build is credited here once its register row names it.
 * Protomaps and MapLibre are the software that renders the map.
 */
const BASEMAP_ATTRIBUTION = [
	...creditsFor([...BASEMAP_INPUTS[LOADED_BASEMAP], ...HILLSHADE_INPUTS, ...CITY_MODEL_INPUTS]).map((credit) => (
		<a key={credit.sourceID} href={credit.url} target="_blank" rel="noreferrer">
			{credit.text}
		</a>
	)),
	// The undersea labels and search read the GEBCO gazetteer.
	// GEBCO asks for this citation.
	<a key="gebco" href="https://www.gebco.net" target="_blank" rel="noreferrer">
		{UNDERSEA_ATTRIBUTION}
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
	 * Which artifact is loading, since the progress bar only reports progress.
	 *
	 * The canned runtime loads no artifact, so this component is absent there.
	 */
	status?: ReactNode
}

export function EarthFooter({ status }: EarthFooterProps): ReactNode {
	return (
		<MapFooter
			identity={<AppIdentity name="Mailwoman Earth" docsURL="https://mailwoman.post/docs" commitHref={commitURL} />}
			status={status}
			attribution={ATTRIBUTION}
		/>
	)
}
