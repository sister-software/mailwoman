// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import type { PlanetaryMapConfig } from "#bodies/config"

const VERSION = "20260908-e2d9f96c"

/**
 * Mars at `mars.mailwoman.post`, opening on Tharsis so Olympus Mons
 * and the three Tharsis Montes are in the first view.
 */
export const MARS: PlanetaryMapConfig = {
	body: "mars",
	title: "Mailwoman Mars",
	displayName: "Mars",
	hostname: "mars.mailwoman.post",
	initialView: { longitude: -110, latitude: 10, zoom: 2 },
	latitudeType: "planetocentric",
	terrainCredit: "NASA MGS MOLA",
	// The tallest volcano, the largest canyon, the deepest basin, a landing site and a polar cap —
	// five features that span the body's range, so the chips are a tour rather than a sample.
	exampleFeatures: ["Olympus Mons", "Valles Marineris", "Hellas Planitia", "Gale", "Planum Boreum"],
	tiles: {
		nomenclature: "https://tiles.mailwoman.post/mars.json",
		hillshade: "https://tiles.mailwoman.post/mars-terrain.json",
	},
	artifacts: {
		version: VERSION,
		searchIndexURL: `https://public.mailwoman.post/planetary/mars/${VERSION}/search.ancestrie`,
		manifestURL: `https://public.mailwoman.post/planetary/mars/${VERSION}/manifest.json`,
	},
	identity: {
		origin: "https://mars.mailwoman.post/",
		name: "Mailwoman Mars",
		shortName: "Mars",
		themeColor: "#0a0604",
	},
}
