/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { PWAIdentity } from "@mailwoman/site-kit/vite/pwa"

import type { PlanetaryBody } from "#body"

export interface PlanetaryView {
	longitude: number
	latitude: number
	zoom: number
}

/**
 * Everything one body's build needs that the other's differs in. The artifact URLs pin one pipeline publish, the way
 * Earth's resource versions pin one gazetteer build; a republish moves the pin by a commit here.
 */
export interface PlanetaryMapConfig {
	body: PlanetaryBody
	title: string
	/**
	 * The body's own name, for prose that already sits under the title — "Search Mars", "About Mars".
	 *
	 * Carried rather than derived: six call sites stripped the `"Mailwoman "` prefix off {@link title} themselves, and
	 * every one of them answers the WHOLE title the day that prefix changes, which reads as a bug in the sentence rather
	 * than in the config.
	 */
	displayName: string
	hostname: string
	initialView: PlanetaryView
	/**
	 * The latitude convention the archives carry, shown beside a coordinate so a reader knows which one they read.
	 */
	latitudeType: "planetocentric" | "planetographic"
	/**
	 * The mission and instrument behind the DEM the hillshade was rendered from, as the attribution names it.
	 */
	terrainCredit: string
	/**
	 * Named features offered as chips under the search field, so a visitor who does not know the nomenclature has
	 * somewhere to start. Each string is searched exactly as typed, so it must match a feature name in the body's search
	 * artifact.
	 */
	exampleFeatures: ReadonlyArray<string>
	tiles: {
		/**
		 * The TileJSON of the nomenclature vector tileset on the tile worker.
		 */
		nomenclature: string
		/**
		 * The TileJSON of the hillshade raster tileset on the tile worker.
		 */
		hillshade: string
	}
	artifacts: {
		/**
		 * The pipeline's build version, `YYYYMMDD-<digest>`, as `astrogeology publish` printed it.
		 */
		version: string
		searchIndexURL: string
		manifestURL: string
	}
	identity: PWAIdentity
}
