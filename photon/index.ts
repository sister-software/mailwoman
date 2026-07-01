/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `@mailwoman/photon` — a Photon-compatible autocomplete / type-ahead geocoding API over the
 *   Mailwoman engine. Where `@mailwoman/nominatim` is structured lookup, Photon is
 *   search-as-you-type: a GeoJSON `FeatureCollection` per query, biased by location, ranked for
 *   prefixes. It maps onto Mailwoman's shipped FST autocomplete tier (#190/#587) + parse →
 *   resolve.
 *
 *   Like its sibling, the package is engine-agnostic: {@link createPhotonRouter} takes a
 *   {@link PhotonEngine}; the CLI wires the real engine. Implementation is staged on the epic (#801
 *   / the Photon child); routes whose engine method is absent answer `501`.
 */

import { type RequestHandler, Router } from "express"

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

const DEFAULT_LIMIT = 15

function asString(raw: unknown): string | undefined {
	return typeof raw === "string" && raw.length > 0 ? raw : undefined
}

function asStringArray(raw: unknown): string[] | undefined {
	if (Array.isArray(raw)) return raw.filter((v): v is string => typeof v === "string")
	const s = asString(raw)

	return s ? [s] : undefined
}

const EMPTY: PhotonFeatureCollection = { type: "FeatureCollection", features: [] }

/**
 * Build the Photon-compatible router around an injected {@link PhotonEngine}. Param parsing lives here; the feature
 * _projection_ (resolved place → {@link PhotonProperties}) is the staged work.
 */
export function createPhotonRouter(engine: PhotonEngine): Router {
	const router = Router()

	const search: RequestHandler = async (req, res) => {
		if (!engine.search) {
			res.status(501).json({ ...EMPTY, message: "search not implemented" })

			return
		}
		const q = req.query
		const query = asString(q["q"])

		if (!query) {
			res.status(400).json({ ...EMPTY, message: "q is required" })

			return
		}
		const params: PhotonSearchParams = {
			q: query,
			limit: Number(q["limit"] ?? DEFAULT_LIMIT) || DEFAULT_LIMIT,
			lang: asString(q["lang"]),
			lat: q["lat"] != null ? Number(q["lat"]) : undefined,
			lon: q["lon"] != null ? Number(q["lon"]) : undefined,
			osmTag: asStringArray(q["osm_tag"]),
			layer: asStringArray(q["layer"]),
		}
		res.json(await engine.search(params))
	}

	const reverse: RequestHandler = async (req, res) => {
		if (!engine.reverse) {
			res.status(501).json({ ...EMPTY, message: "reverse not implemented" })

			return
		}
		const q = req.query
		const lat = Number(q["lat"])
		const lon = Number(q["lon"])

		if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
			res.status(400).json({ ...EMPTY, message: "lat and lon are required" })

			return
		}

		if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
			res.status(400).json({ ...EMPTY, message: "lat must be in [-90, 90] and lon in [-180, 180]" })

			return
		}
		const params: PhotonReverseParams = {
			lat,
			lon,
			limit: Number(q["limit"] ?? DEFAULT_LIMIT) || DEFAULT_LIMIT,
			lang: asString(q["lang"]),
			radius: q["radius"] != null ? Number(q["radius"]) : undefined,
		}
		res.json(await engine.reverse(params))
	}

	// Safety net: malformed input or an engine fault returns an empty FeatureCollection, never a crash.
	const safe =
		(fn: RequestHandler): RequestHandler =>
		async (req, res, next) => {
			try {
				await fn(req, res, next)
			} catch {
				if (!res.headersSent) res.status(500).json({ ...EMPTY, message: "internal error" })
			}
		}

	router.get("/api", safe(search))
	router.get("/reverse", safe(reverse))

	return router
}

/** Build a Photon `Feature` from a coordinate + properties. */
export function photonFeature(lon: number, lat: number, properties: PhotonProperties): PhotonFeature {
	return { type: "Feature", geometry: { type: "Point", coordinates: [lon, lat] }, properties }
}

/** Wrap features in a Photon `FeatureCollection`. */
export function photonCollection(features: PhotonFeature[]): PhotonFeatureCollection {
	return { type: "FeatureCollection", features }
}
