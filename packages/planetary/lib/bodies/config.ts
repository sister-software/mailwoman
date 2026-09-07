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
	hostname: string
	initialView: PlanetaryView
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
