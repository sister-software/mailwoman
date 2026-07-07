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

/** Options for {@link createPhotonRouter}. */
export interface PhotonRouterOptions {
	/**
	 * Emit permissive CORS headers (`Access-Control-Allow-Origin: *`) on every response and answer preflight `OPTIONS`
	 * with `204`. Default `true` — upstream komoot/photon serves permissive CORS, and the map-widget use case
	 * (leaflet-control-geocoder, @openrunner/photon-geocoder, …) needs it: a browser's cross-origin XHR is blocked
	 * without it (#1017). Set `false` when a reverse proxy already owns the CORS headers.
	 */
	cors?: boolean
}

/**
 * Permissive CORS, matching upstream Photon: `Access-Control-Allow-Origin: *` on every response, plus a `204` answer to
 * preflight `OPTIONS`. `ACAO: *` is anonymous (no credentials), so a wildcard `Allow-Headers` is valid.
 */
const applyCors: RequestHandler = (req, res, next) => {
	res.setHeader("Access-Control-Allow-Origin", "*")
	res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS")
	res.setHeader("Access-Control-Allow-Headers", "*")

	if (req.method === "OPTIONS") {
		res.setHeader("Access-Control-Max-Age", "86400")
		res.status(204).end()

		return
	}
	next()
}

/**
 * Build the Photon-compatible router around an injected {@link PhotonEngine}. Param parsing lives here; the feature
 * _projection_ (resolved place → {@link PhotonProperties}) is the staged work.
 */
export function createPhotonRouter(engine: PhotonEngine, options: PhotonRouterOptions = {}): Router {
	const router = Router()

	// Browser-embedded widgets need CORS or their cross-origin XHR is blocked before the request completes (#1017).
	if (options.cors !== false) {
		router.use(applyCors)
	}

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
				if (!res.headersSent) {
					res.status(500).json({ ...EMPTY, message: "internal error" })
				}
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

/**
 * The resolved-place info a forward `/api` result carries: the admin ladder (MOST-SPECIFIC first) with GAZETTEER names,
 * the coordinate, the resolved country, and the postcode. {@link photonForwardProperties} projects it onto Photon's
 * schema. #1014 — decorate from the resolved place, not the parsed input span.
 */
export interface PhotonForwardInput {
	lat: number
	lon: number
	postcode?: string | null
	/** The resolved country, mapped by the caller (ISO2 → canonical name via `@mailwoman/codex`). */
	country?: { name?: string; code?: string } | null
	/** Resolved admin ancestry, most-specific first, each carrying the gazetteer's canonical name (not the parsed span). */
	places: ReadonlyArray<{ tag: string; name: string }>
}

/**
 * How a resolved tag projects onto Photon's schema: the property key that holds its name, plus the OSM `key`/`value`/
 * `type` a Photon client reads. Kept close to komoot Photon's own values so client label-builders behave.
 */
const FORWARD_TAG_PROJECTION: Record<
	string,
	{ key: keyof PhotonProperties; osmKey: string; osmValue: string; type: string }
> = {
	venue: { key: "name", osmKey: "amenity", osmValue: "yes", type: "house" },
	house: { key: "name", osmKey: "building", osmValue: "yes", type: "house" },
	street: { key: "street", osmKey: "highway", osmValue: "residential", type: "street" },
	neighbourhood: { key: "district", osmKey: "place", osmValue: "suburb", type: "district" },
	dependent_locality: { key: "district", osmKey: "place", osmValue: "suburb", type: "district" },
	borough: { key: "district", osmKey: "place", osmValue: "borough", type: "district" },
	locality: { key: "city", osmKey: "place", osmValue: "city", type: "city" },
	// WOF placetypes the /reverse hierarchy uses (so both endpoints derive osm tags from ONE table).
	localadmin: { key: "city", osmKey: "place", osmValue: "city", type: "city" },
	subregion: { key: "county", osmKey: "place", osmValue: "county", type: "county" },
	county: { key: "county", osmKey: "place", osmValue: "county", type: "county" },
	region: { key: "state", osmKey: "place", osmValue: "state", type: "state" },
	macroregion: { key: "state", osmKey: "place", osmValue: "state", type: "state" },
	country: { key: "country", osmKey: "place", osmValue: "country", type: "country" },
}

/** Fallback OSM tags — a Photon client reads `osm_key`/`osm_value`/`type` unconditionally, so they must never be absent. */
const DEFAULT_OSM_TAGS = { osm_key: "place", osm_value: "yes", type: "other" } as const

/**
 * The Photon `osm_key`/`osm_value`/`type` for a resolved tag or WOF placetype (`locality`, `region`, `country`, …),
 * falling back to a safe default so the fields are always present. Shared by the forward projection and `/reverse` so
 * the two endpoints report a place the SAME way. #1014.
 */
export function photonOSMTags(tagOrPlacetype: string): { osm_key: string; osm_value: string; type: string } {
	const proj = FORWARD_TAG_PROJECTION[tagOrPlacetype]

	return proj ? { osm_key: proj.osmKey, osm_value: proj.osmValue, type: proj.type } : { ...DEFAULT_OSM_TAGS }
}

/**
 * Project a resolved forward result into Photon properties — decorating from the RESOLVED gazetteer place (proper-cased
 * names + ancestry + country), NOT the parsed input span, and ALWAYS emitting `osm_key`/`osm_value`/`type` so Photon
 * client libraries (leaflet-control-geocoder, @openrunner/photon-geocoder) never dereference undefined. #1014.
 */
export function photonForwardProperties(input: PhotonForwardInput): PhotonProperties {
	// Safe defaults: a Photon client reads osm_key/osm_value/type unconditionally, so they must never be undefined.
	const props: PhotonProperties = { ...DEFAULT_OSM_TAGS }
	const [primary] = input.places

	if (primary) {
		props.name = primary.name
		Object.assign(props, photonOSMTags(primary.tag))
	}

	for (const place of input.places) {
		const proj = FORWARD_TAG_PROJECTION[place.tag]

		if (proj && props[proj.key] == null) {
			props[proj.key] = place.name
		}
	}

	if (input.postcode) {
		props.postcode = input.postcode
	}

	if (input.country?.name && props.country == null) {
		props.country = input.country.name
	}

	if (input.country?.code) {
		props.countrycode = input.country.code.toLowerCase()
	}

	return props
}

/** {@link photonForwardProperties}, wrapped as a Photon Point `Feature` at the resolved coordinate. #1014. */
export function photonForwardFeature(input: PhotonForwardInput): PhotonFeature {
	return photonFeature(input.lon, input.lat, photonForwardProperties(input))
}

/** The winning place plus its ranked alternatives — the input to {@link photonForwardCollection}. #1016. */
export interface PhotonForwardResult {
	/** The winning place, with full admin ancestry (from the resolved hierarchy). */
	primary: PhotonForwardInput
	/** Ranked alternative places (Springfield MA / IL / …), each a single-place input; excludes the primary. */
	alternatives: PhotonForwardInput[]
}

/**
 * Assemble a Photon `FeatureCollection` honoring `limit` (#1016): the primary feature first, then ranked alternatives,
 * capped at `limit`. `limit` floors to 1 (Photon always returns at least the best match).
 */
export function photonForwardCollection(result: PhotonForwardResult, limit: number): PhotonFeatureCollection {
	const cap = Math.max(1, Math.floor(limit) || 1)
	const features = [photonForwardFeature(result.primary)]

	for (const alt of result.alternatives) {
		if (features.length >= cap) break
		features.push(photonForwardFeature(alt))
	}

	return photonCollection(features)
}
