/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The bodies this pipeline builds; a body is explicit in every record and artifact, and no code
 *   here treats Earth as the reference.
 */

import { BODY_RADII_KM, type PlanetaryBodyID } from "@mailwoman/spatial"

export interface PlanetaryCoordinateMetadata {
	longitudeDirection: "east" | "west"
	longitudeRange: "-180..180" | "0..360"
	latitudeType: "planetocentric" | "planetographic"
	referenceBody: string
	controlNetwork?: string
}

export interface PlanetaryBody {
	id: Exclude<PlanetaryBodyID, "earth">
	name: string
	iauTargetName: string
	meanRadiusKm: number
	shape: "sphere" | "ellipsoid"
	/**
	 * The hillshade's vertical scale, and the only place a degree becomes a length in this package.
	 */
	metresPerDegree: number
	coordinates: PlanetaryCoordinateMetadata
}

const metresPerDegree = (radiusKm: number): number => (2 * Math.PI * radiusKm * 1000) / 360

/**
 * The two bodies the pipeline builds, keyed by id.
 *
 * The reference bodies, control networks and longitude conventions are the ones the
 * usgs nomenclature shapefiles declare; the radii come from `@mailwoman/spatial`,
 * so a distance on either body scales by the same number the app measures with.
 */
export const BODIES = {
	moon: {
		id: "moon",
		name: "Moon",
		iauTargetName: "Moon",
		meanRadiusKm: BODY_RADII_KM.moon,
		shape: "sphere",
		metresPerDegree: metresPerDegree(BODY_RADII_KM.moon),
		coordinates: {
			longitudeDirection: "east",
			longitudeRange: "0..360",
			latitudeType: "planetocentric",
			referenceBody: "Moon_2000_IAU_IAG (sphere, 1737400 m)",
			controlNetwork: "LOLA 2011",
		},
	},
	mars: {
		id: "mars",
		name: "Mars",
		iauTargetName: "Mars",
		meanRadiusKm: BODY_RADII_KM.mars,
		shape: "ellipsoid",
		metresPerDegree: metresPerDegree(BODY_RADII_KM.mars),
		coordinates: {
			longitudeDirection: "east",
			longitudeRange: "0..360",
			latitudeType: "planetocentric",
			referenceBody: "Mars_2000_IAU_IAG (ellipsoid, 3396190 m, 1/f 169.894)",
			controlNetwork: "MDIM 2.1",
		},
	},
} as const satisfies Record<"moon" | "mars", PlanetaryBody>

export type BuildableBodyID = keyof typeof BODIES
