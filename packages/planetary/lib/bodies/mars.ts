/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { PlanetaryMapConfig } from "#bodies/config"

const VERSION = "20260908-e2d9f96c"

/**
 * Mars at `mars.mailwoman.ai`, opening on Tharsis so Olympus Mons and the three Tharsis Montes are in the first view.
 */
export const MARS: PlanetaryMapConfig = {
	body: "mars",
	title: "Mailwoman Mars",
	displayName: "Mars",
	hostname: "mars.mailwoman.ai",
	initialView: { longitude: -110, latitude: 10, zoom: 2 },
	latitudeType: "planetocentric",
	terrainCredit: "NASA MGS MOLA",
	// The tallest volcano, the largest canyon, the deepest basin, a landing site and a polar cap — five features that
	// carry the range of the body, so the chips are a tour rather than a sample.
	exampleFeatures: ["Olympus Mons", "Valles Marineris", "Hellas Planitia", "Gale", "Planum Boreum"],
	tiles: {
		nomenclature: "https://tiles.mailwoman.ai/mars.json",
		hillshade: "https://tiles.mailwoman.ai/mars-terrain.json",
	},
	artifacts: {
		version: VERSION,
		searchIndexURL: `https://public.mailwoman.ai/planetary/mars/${VERSION}/search.ancestrie`,
		manifestURL: `https://public.mailwoman.ai/planetary/mars/${VERSION}/manifest.json`,
	},
	identity: {
		origin: "https://mars.mailwoman.ai/",
		name: "Mailwoman Mars",
		shortName: "Mars",
		themeColor: "#0a0604",
	},
}
