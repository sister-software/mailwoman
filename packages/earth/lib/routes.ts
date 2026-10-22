/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * The app's three client routes, read from `location.pathname` with no router: Cloudflare's SPA fallback serves
 * `index.html` for every path, so an unknown path is a not-found view rather than the geocoder and a stale link
 * fails visibly.
 */

import { isValidLatitude, isValidLongitude } from "@mailwoman/spatial/coordinate/bounds"
import { wrapLongitude } from "@mailwoman/spatial/position"

/**
 * The three views the app serves: the geocoder at `/`, the debug drawer at `/debug`,
 * and the trace page at `/trace`.
 */
export const Route = {
	Geocoder: "geocoder",
	Debug: "debug",
	Trace: "trace",
} as const

export type Route = (typeof Route)[keyof typeof Route]

const ROUTES_BY_PATH: ReadonlyMap<string, Route> = new Map([
	["/", Route.Geocoder],
	["/debug", Route.Debug],
	["/trace", Route.Trace],
])

/**
 * The route a pathname names, with a trailing slash forgiven, or null for a path the app does not serve.
 */
export function routeForPath(pathname: string): Route | null {
	const normalized = pathname.replace(CAMERA_SEGMENT, "").replace(/\/+$/u, "") || "/"

	return ROUTES_BY_PATH.get(normalized) ?? null
}

/**
 * The current page's value for a query parameter, or null when the page URL lacks it
 * or the code runs outside a browser.
 * A bare flag such as `?no-model` reads as the empty string.
 */
export function pageSearchParam(name: string): string | null {
	return typeof location !== "undefined" ? new URLSearchParams(location.search).get(name) : null
}

/**
 * Which runtime the page mounts: `fake` is the canned runtime the shell smoke and the stories use.
 * Any other value or no value selects the real geocoder.
 */
export type RuntimeMode = "real" | "fake"

export function runtimeModeFromSearch(search: string): RuntimeMode {
	return new URLSearchParams(search).get("runtime") === "fake" ? "fake" : "real"
}

/**
 * The `?q=` query, decoded, or null when absent or blank.
 *
 * Blank is null so a link carrying `?q=` with no value behaves like a link without it.
 */
export function queryFromSearch(search: string): string | null {
	const value = new URLSearchParams(search).get("q")

	if (!value) return null

	return value.trim() === "" ? null : value
}

/**
 * The initial camera that the page URL requests.
 */
export interface CameraParams {
	/**
	 * `[lon, lat]`.
	 */
	center: [number, number]
	zoom: number | null
}

/**
 * A trailing camera segment in Google Maps' form, `/@<lat>,<lon>,<zoom>z`, with the zoom optional.
 */
const CAMERA_SEGMENT = /\/@(-?[\d.]+),(-?[\d.]+)(?:,([\d.]+)z)?\/?$/u

/**
 * Decimal places written for a coordinate.
 *
 * Seven places resolve about 1 cm, which matches Google Maps' links.
 */
const COORDINATE_DECIMALS = 7

/**
 * Decimal places written for a zoom level, enough for fractional zooms such as `16.5z`.
 */
const ZOOM_DECIMALS = 2

/**
 * The camera a path asks for, from a trailing `/@<lat>,<lon>,<zoom>z` segment.
 *
 * The segment follows Google Maps' order, latitude first.
 * Returns null when the path has no segment or its coordinates are out of range.
 */
export function cameraFromPath(pathname: string): CameraParams | null {
	const match = CAMERA_SEGMENT.exec(pathname)

	if (!match) return null

	const lat = Number(match[1])
	const lon = Number(match[2])

	if (!isValidLongitude(lon) || !isValidLatitude(lat)) return null

	const zoom = match[3] ? Number(match[3]) : Number.NaN

	return { center: [lon, lat], zoom: Number.isFinite(zoom) ? zoom : null }
}

/**
 * The camera a URL asks for: the path's `/@<lat>,<lon>,<zoom>z` segment,
 * or else the older `?center=<lon>,<lat>&zoom=<z>` parameters.
 */
export function cameraFromLocation(pathname: string, search: string): CameraParams | null {
	return cameraFromPath(pathname) ?? cameraFromSearch(search)
}

/**
 * The URL that records a camera, as `<route>/@<lat>,<lon>,<zoom>z` with the query string kept.
 *
 * The older `center` and `zoom` parameters are removed so the URL states one camera.
 * It returns a string rather than writing history so the caller chooses `pushState` or `replaceState`.
 */
export function pathWithCamera(url: URL, center: readonly [lon: number, lat: number], zoom: number): string {
	const next = new URL(url)
	const route = next.pathname.replace(CAMERA_SEGMENT, "").replace(/\/+$/u, "")
	const [lon, lat] = center

	next.pathname = `${route}/@${decimalText(lat, COORDINATE_DECIMALS)},${decimalText(wrapLongitude(lon), COORDINATE_DECIMALS)},${decimalText(zoom, ZOOM_DECIMALS)}z`

	// Deleting a parameter reserializes the whole query, which percent-encodes a URL value such as `?basemap=`.
	if (next.searchParams.has("center") || next.searchParams.has("zoom")) {
		next.searchParams.delete("center")
		next.searchParams.delete("zoom")
	}

	return `${next.pathname}${next.search}${next.hash}`
}

/**
 * A number in fixed-point notation with trailing zeroes dropped.
 *
 * `Number#toString` writes values below 1e-6 in exponent form, such as `1e-7`,
 * which the camera segment cannot read.
 */
function decimalText(value: number, decimals: number): string {
	const text = value
		.toFixed(decimals)
		.replace(/(\.\d*?)0+$/u, "$1")
		.replace(/\.$/u, "")

	return text === "-0" ? "0" : text
}

/**
 * The camera a link asks for: `?center=<lon>,<lat>` with an optional `&zoom=<z>`.
 *
 * Returns null when `center` is absent or is not two finite numbers inside longitude and latitude range.
 * A malformed `zoom` leaves the zoom to the app default.
 */
export function cameraFromSearch(search: string): CameraParams | null {
	const params = new URLSearchParams(search)
	const parts = params.get("center")?.split(",").map(Number)

	if (parts?.length !== 2) return null

	const [lon, lat] = parts as [number, number]

	if (!isValidLongitude(lon) || !isValidLatitude(lat)) return null

	const zoomValue = params.get("zoom")
	const zoom = zoomValue === null ? Number.NaN : Number(zoomValue)

	return { center: [lon, lat], zoom: Number.isFinite(zoom) ? zoom : null }
}

/**
 * The URL a search should leave behind — `q` set, or removed when the query is blank —
 * carrying every other parameter, including a viewport or runtime flag, through untouched.
 *
 * It returns a string rather than writing history so the caller chooses `pushState` or `replaceState`.
 */
export function searchWithQuery(url: URL, query: string): string {
	const next = new URL(url)

	if (query.trim() === "") {
		next.searchParams.delete("q")
	} else {
		next.searchParams.set("q", query)
	}

	return `${next.pathname}${next.search}${next.hash}`
}
