/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `@mailwoman/nominatim` — a Nominatim-compatible HTTP geocoding API over the Mailwoman engine.
 *
 *   The package is intentionally engine-agnostic: {@link createNominatimRouter} takes a
 *   {@link NominatimEngine} (the thing that actually parses + resolves) and exposes it under the
 *   endpoint shapes + response format a Nominatim client expects. The CLI (`./cli.ts`) wires the
 *   real Mailwoman engine; tests can inject a fake. This keeps the compat surface isolated from the
 *   resolver wiring.
 *
 *   Implementation is staged across the epic (#801): #804 the result formatter, #802 `/search`, #803
 *   `/reverse`, #805 `/lookup` + `/status`. Routes whose engine method is absent answer `501`.
 */

import type { OpenCageAnnotations } from "@mailwoman/annotations"
import { type RequestHandler, Router } from "express"

/** Output serialization formats Nominatim supports. `jsonv2` is the modern default. */
export type NominatimFormat = "jsonv2" | "json" | "geojson"

/**
 * The structured address breakdown returned under `address` when `addressdetails=1`. Keys mirror Nominatim's
 * OSM-derived tag names; populated from Mailwoman's `ComponentTag` / resolved ancestor lineage (mapping owned by
 * #804).
 */
export interface NominatimAddressDetails {
	house_number?: string
	road?: string
	neighbourhood?: string
	suburb?: string
	city?: string
	town?: string
	village?: string
	county?: string
	state?: string
	postcode?: string
	country?: string
	country_code?: string
	[key: string]: string | undefined
}

/** A single Nominatim result object (the shape geopy and friends parse). */
export interface NominatimResult {
	place_id: number | string
	licence: string
	osm_type?: string
	osm_id?: number | string
	lat: string
	lon: string
	display_name: string
	/** `[south, north, west, east]` as strings, per Nominatim. */
	boundingbox?: [string, string, string, string]
	class?: string
	type?: string
	importance?: number
	place_rank?: number
	address?: NominatimAddressDetails
	/** Present when `format=geojson` or `polygon_geojson=1`. */
	geojson?: unknown
	/** OpenCage-style enrichment block (timezone, coordinate formats, …); attached by the engine. */
	annotations?: OpenCageAnnotations
}

/** Parsed `/search` parameters (free-text OR structured; never both). */
export interface NominatimSearchParams {
	q?: string
	street?: string
	city?: string
	county?: string
	state?: string
	country?: string
	postalcode?: string
	countrycodes?: string[]
	limit: number
	viewbox?: [number, number, number, number]
	bounded?: boolean
	addressdetails?: boolean
	format: NominatimFormat
	acceptLanguage?: string
}

/** Parsed `/reverse` parameters. */
export interface NominatimReverseParams {
	lat: number
	lon: number
	zoom?: number
	addressdetails?: boolean
	format: NominatimFormat
	acceptLanguage?: string
}

/** Parsed `/lookup` parameters. */
export interface NominatimLookupParams {
	osmIds: string[]
	addressdetails?: boolean
	format: NominatimFormat
}

/** Nominatim `/status` payload. */
export interface NominatimStatus {
	status: number
	message: string
	data_updated?: string
}

/**
 * The geocoding engine the router delegates to. Each method is optional; a route whose method is not provided answers
 * `501 Not Implemented`. The real implementation (Mailwoman parse → resolve, plus `WOFReverseGeocoder`) is wired by the
 * CLI and fleshed out across #802–#805.
 */
export interface NominatimEngine {
	search?(params: NominatimSearchParams): Promise<NominatimResult[]>
	reverse?(params: NominatimReverseParams): Promise<NominatimResult | null>
	lookup?(params: NominatimLookupParams): Promise<NominatimResult[]>
	status?(): Promise<NominatimStatus>
}

const DEFAULT_LIMIT = 10

function parseFormat(raw: unknown): NominatimFormat {
	return raw === "geojson" || raw === "json" ? raw : "jsonv2"
}

function parseBool(raw: unknown): boolean {
	return raw === "1" || raw === "true"
}

function asString(raw: unknown): string | undefined {
	return typeof raw === "string" && raw.length > 0 ? raw : undefined
}

/** A GeoJSON `FeatureCollection` — the `format=geojson` envelope. */
export interface NominatimFeatureCollection {
	type: "FeatureCollection"
	features: Array<{
		type: "Feature"
		properties: Record<string, unknown>
		geometry: unknown
		bbox?: [number, number, number, number]
	}>
}

/**
 * Render results as a GeoJSON `FeatureCollection` (`format=geojson`). Nominatim moves the coordinate into `geometry` (a
 * Point, or the place polygon when one is present), `boundingbox` ([south, north, west, east]) into a GeoJSON `bbox`
 * ([west, south, east, north]), and the remaining result fields into `properties`. Rows without a coordinate are
 * dropped — a Feature needs a geometry.
 */
export function toFeatureCollection(results: readonly NominatimResult[]): NominatimFeatureCollection {
	const features: NominatimFeatureCollection["features"] = []

	for (const r of results) {
		if (r.lat == null || r.lon == null) continue
		const { lat, lon, boundingbox, geojson, ...properties } = r
		const feature: NominatimFeatureCollection["features"][number] = {
			type: "Feature",
			properties,
			geometry: geojson ?? { type: "Point", coordinates: [Number(lon), Number(lat)] },
		}

		if (boundingbox?.length === 4) {
			// boundingbox is [south, north, west, east]; GeoJSON bbox is [west, south, east, north].
			feature.bbox = [Number(boundingbox[2]), Number(boundingbox[0]), Number(boundingbox[3]), Number(boundingbox[1])]
		}
		features.push(feature)
	}

	return { type: "FeatureCollection", features }
}

/** Options for {@link createNominatimRouter}. */
export interface NominatimRouterOptions {
	/**
	 * Emit permissive CORS headers (`Access-Control-Allow-Origin: *`) on every response and answer preflight `OPTIONS`
	 * with `204`. Default `true` — browser-embedded geocoder clients need it: a cross-origin XHR is blocked without it
	 * (#1017). Set `false` when a reverse proxy already owns the CORS headers.
	 */
	cors?: boolean
}

/**
 * Permissive CORS: `Access-Control-Allow-Origin: *` on every response, plus a `204` answer to preflight `OPTIONS`.
 * `ACAO: *` is anonymous (no credentials), so a wildcard `Allow-Headers` is valid.
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
 * Build the Nominatim-compatible router around an injected {@link NominatimEngine}. Query-param parsing lives here; the
 * result _formatting_ (jsonv2 vs geojson envelope, `address` projection) is #804 and currently passes the engine's
 * results through verbatim.
 */
export function createNominatimRouter(engine: NominatimEngine, options: NominatimRouterOptions = {}): Router {
	const router = Router()

	// Browser-embedded geocoder clients need CORS or their cross-origin XHR is blocked before completing (#1017).
	if (options.cors !== false) {
		router.use(applyCors)
	}

	const search: RequestHandler = async (req, res) => {
		if (!engine.search) {
			res.status(501).json({ error: "search not implemented (see #802)" })

			return
		}
		const q = req.query
		const params: NominatimSearchParams = {
			q: asString(q["q"]),
			street: asString(q["street"]),
			city: asString(q["city"]),
			county: asString(q["county"]),
			state: asString(q["state"]),
			country: asString(q["country"]),
			postalcode: asString(q["postalcode"]),
			countrycodes: asString(q["countrycodes"])?.split(","),
			limit: Number(q["limit"] ?? DEFAULT_LIMIT) || DEFAULT_LIMIT,
			bounded: parseBool(q["bounded"]),
			addressdetails: parseBool(q["addressdetails"]),
			format: parseFormat(q["format"]),
			acceptLanguage: asString(q["accept-language"]),
		}
		const results = await engine.search(params)
		res.json(params.format === "geojson" ? toFeatureCollection(results) : results)
	}

	const reverse: RequestHandler = async (req, res) => {
		if (!engine.reverse) {
			res.status(501).json({ error: "reverse not implemented (see #803)" })

			return
		}
		const q = req.query
		const lat = Number(q["lat"])
		const lon = Number(q["lon"])

		if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
			res.status(400).json({ error: "lat and lon are required" })

			return
		}

		if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
			res.status(400).json({ error: "lat must be in [-90, 90] and lon in [-180, 180]" })

			return
		}
		const params: NominatimReverseParams = {
			lat,
			lon,
			zoom: q["zoom"] != null ? Number(q["zoom"]) : undefined,
			addressdetails: parseBool(q["addressdetails"]),
			format: parseFormat(q["format"]),
			acceptLanguage: asString(q["accept-language"]),
		}
		const result = await engine.reverse(params)
		res.json(params.format === "geojson" ? toFeatureCollection(result ? [result] : []) : result)
	}

	const lookup: RequestHandler = async (req, res) => {
		if (!engine.lookup) {
			res.status(501).json({ error: "lookup not implemented (see #805)" })

			return
		}
		const params: NominatimLookupParams = {
			osmIds: asString(req.query["osm_ids"])?.split(",") ?? [],
			addressdetails: parseBool(req.query["addressdetails"]),
			format: parseFormat(req.query["format"]),
		}
		const results = await engine.lookup(params)
		res.json(params.format === "geojson" ? toFeatureCollection(results) : results)
	}

	const status: RequestHandler = async (_req, res) => {
		if (!engine.status) {
			res.json({ status: 0, message: "OK" } satisfies NominatimStatus)

			return
		}
		res.json(await engine.status())
	}

	// Safety net: a malformed query (whitespace-only, absurdly long, control chars) or an engine fault
	// must never crash the process into a stack-trace 500. Wrap every handler so an unexpected throw
	// becomes a clean JSON error.
	const safe =
		(fn: RequestHandler): RequestHandler =>
		async (req, res, next) => {
			try {
				await fn(req, res, next)
			} catch {
				if (!res.headersSent) {
					res.status(500).json({ error: "internal error" })
				}
			}
		}

	router.get("/search", safe(search))
	router.get("/reverse", safe(reverse))
	router.get("/lookup", safe(lookup))
	router.get("/status", safe(status))

	return router
}

/**
 * A resolved address in a neutral shape, the input to {@link toNominatimResult}. The engine maps its native
 * geocode/reverse result into this; the formatter renders it as a Nominatim result. This is the #804 mapping seam, kept
 * dependency-free (no `@mailwoman/*` import) so it stays unit-testable.
 */
export interface ResolvedAddress {
	lat: number | null
	lon: number | null
	address: NominatimAddressDetails
	/** Pre-rendered display name; falls back to the address values joined by ", ". */
	displayName?: string
	category?: string
	type?: string
	importance?: number
	placeRank?: number
	boundingbox?: [string, string, string, string]
	/** A stable id from the resolver (WOF/GERS); a deterministic hash is used when absent. */
	placeID?: string | number
}

/** The attribution string emitted as `licence` (the data sources Mailwoman resolves over). */
export const MAILWOMAN_LICENCE = "Data © Who's On First, Overture Maps, OpenAddresses, US Census TIGER"

function stableID(seed: string): number {
	let h = 5381

	for (let i = 0; i < seed.length; i++) {
		h = (h * 33) ^ seed.charCodeAt(i)
	}

	return h >>> 0
}

/**
 * Render a {@link ResolvedAddress} as a Nominatim result. `addressdetails` gates the `address` block, matching
 * Nominatim. The `annotations` block is attached by the caller (empty until the annotations layer lands).
 */
export function toNominatimResult(r: ResolvedAddress, opts: { addressdetails?: boolean } = {}): NominatimResult {
	const displayName = r.displayName ?? Object.values(r.address).filter(Boolean).join(", ")
	const lat = r.lat != null ? String(r.lat) : ""
	const lon = r.lon != null ? String(r.lon) : ""
	const result: NominatimResult = {
		place_id: r.placeID ?? stableID(`${lat},${lon},${displayName}`),
		licence: MAILWOMAN_LICENCE,
		lat,
		lon,
		display_name: displayName,
	}

	if (r.category != null) {
		result.class = r.category
	}

	if (r.type != null) {
		result.type = r.type
	}

	if (r.importance != null) {
		result.importance = r.importance
	}

	if (r.placeRank != null) {
		result.place_rank = r.placeRank
	}

	if (r.boundingbox) {
		result.boundingbox = r.boundingbox
	}

	if (opts.addressdetails) {
		result.address = r.address
	}

	return result
}
