/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The Photon engine contract + wire types the router delegates to. Feature/collection
 *   construction lives here too (`photonFeature`, `photonCollection`) since every projection
 *   builds on them; the RESOLVED-place → {@link PhotonProperties} projection itself lives in
 *   `projection.ts`.
 */

/**
 * Photon feature properties — OSM-derived tag names, populated from Mailwoman's `ComponentTag` / resolved place.
 * `extent` is `[minLon, maxLat, maxLon, minLat]` per Photon's convention.
 */
export interface PhotonProperties {
	osm_id?: number | string
	osm_type?: string
	osm_key?: string
	osm_value?: string
	type?: string
	name?: string
	housenumber?: string
	street?: string
	postcode?: string
	city?: string
	district?: string
	county?: string
	state?: string
	country?: string
	countrycode?: string
	extent?: [number, number, number, number]
	[key: string]: unknown
}

/** A Photon result feature: a GeoJSON Point with {@link PhotonProperties}. */
export interface PhotonFeature {
	type: "Feature"
	geometry: {
		type: "Point"
		coordinates: [number, number]
	}
	properties: PhotonProperties
}

/** The Photon response envelope — a GeoJSON FeatureCollection. */
export interface PhotonFeatureCollection {
	type: "FeatureCollection"
	features: PhotonFeature[]
}

/** Parsed `/api` (forward / autocomplete) parameters. */
export interface PhotonSearchParams {
	q: string
	limit: number
	lang?: string
	/** Location bias. */
	lat?: number
	lon?: number
	bbox?: [number, number, number, number]
	osmTag?: string[]
	layer?: string[]
}

/** Parsed `/reverse` parameters. */
export interface PhotonReverseParams {
	lat: number
	lon: number
	limit: number
	lang?: string
	radius?: number
}

/**
 * The engine the router delegates to. Each method is optional; a missing one answers `501`. The real implementation
 * backs `/api` with the FST autocomplete tier + parse→resolve, and `/reverse` with the `WOFReverseGeocoder`.
 */
export interface PhotonEngine {
	search?(params: PhotonSearchParams): Promise<PhotonFeatureCollection>
	reverse?(params: PhotonReverseParams): Promise<PhotonFeatureCollection>
}

/** Build a Photon `Feature` from a coordinate + properties. */
export function photonFeature(lon: number, lat: number, properties: PhotonProperties): PhotonFeature {
	return { type: "Feature", geometry: { type: "Point", coordinates: [lon, lat] }, properties }
}

/** Wrap features in a Photon `FeatureCollection`. */
export function photonCollection(features: PhotonFeature[]): PhotonFeatureCollection {
	return { type: "FeatureCollection", features }
}
