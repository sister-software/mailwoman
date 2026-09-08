/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The app's routes, read from `location.pathname` with no router. Cloudflare's SPA fallback serves `index.html`
 *   for every path, so the app decides what a path means; a path it does not know is a not-found view, so a stale
 *   link fails visibly rather than showing the globe as if nothing were wrong.
 */

import { withoutTrailingSlashes } from "@mailwoman/core/strings/format"

import type { PlanetaryView } from "#bodies/config"

/**
 * The two views: the globe at `/`, and the globe with one named feature selected at `/feature/<id>`, where the id is
 * the pipeline's stable feature id.
 */
export type PlanetaryRoute = { kind: "map" } | { kind: "feature"; id: string }

const FEATURE_PATH = /^\/feature\/([0-9]+)$/u

/**
 * The route a pathname names, with a trailing slash forgiven, or null for a path the app does not serve.
 */
export function routeForPath(pathname: string): PlanetaryRoute | null {
	const normalized = withoutTrailingSlashes(pathname) || "/"

	if (normalized === "/") return { kind: "map" }

	const feature = FEATURE_PATH.exec(normalized)

	if (feature) return { kind: "feature", id: feature[1]! }

	return null
}

/**
 * The path a route is served at, the inverse of {@link routeForPath}.
 */
export function pathForRoute(route: PlanetaryRoute): string {
	return route.kind === "map" ? "/" : `/feature/${route.id}`
}

/**
 * A viewport carried in the query as `?lon=&lat=&z=`, or null when any of the three is absent or not a finite number.
 * All three or none: a partial viewport is not a viewport.
 */
export function viewportFromSearch(search: string): PlanetaryView | null {
	const params = new URLSearchParams(search)

	const values = ["lon", "lat", "z"].map((key) => {
		const raw = params.get(key)

		return raw === null || raw.trim() === "" ? Number.NaN : Number(raw)
	})

	if (values.some((value) => !Number.isFinite(value))) return null

	const [longitude, latitude, zoom] = values as [number, number, number]

	return { longitude, latitude, zoom }
}
