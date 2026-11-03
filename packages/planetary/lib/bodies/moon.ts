/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { PlanetaryMapConfig } from "#bodies/config"

const VERSION = "20260908-a2c92ed2"

/**
 * The Moon at `moon.mailwoman.post`, opening on the near side at the sub-Earth point.
 */
export const MOON: PlanetaryMapConfig = {
	body: "moon",
	title: "Mailwoman Moon",
	displayName: "Moon",
	hostname: "moon.mailwoman.post",
	initialView: { longitude: 0, latitude: 0, zoom: 1.5 },
	latitudeType: "planetocentric",
	terrainCredit: "NASA LRO LOLA",
	// The Apollo 11 landing sea, a ray crater, the near side's largest mare, the south-polar basin and
	// a rille — five features that span the body's range, so the chips are a tour rather than a sample.
	exampleFeatures: ["Mare Tranquillitatis", "Copernicus", "Oceanus Procellarum", "Tycho", "Vallis Alpes"],
	tiles: {
		nomenclature: "https://tiles.mailwoman.post/moon.json",
		hillshade: "https://tiles.mailwoman.post/moon-terrain.json",
	},
	artifacts: {
		version: VERSION,
		searchIndexURL: `https://public.mailwoman.post/planetary/moon/${VERSION}/search.ancestrie`,
		manifestURL: `https://public.mailwoman.post/planetary/moon/${VERSION}/manifest.json`,
	},
	identity: {
		origin: "https://moon.mailwoman.post/",
		name: "Mailwoman Moon",
		shortName: "Moon",
		themeColor: "#05070d",
	},
}
