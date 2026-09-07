/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The app's three client routes, read from `location.pathname` with no router. Cloudflare's SPA fallback serves
 *   `index.html` for every path, so the app decides what a path means; a path it does not know is not the geocoder,
 *   it is a not-found view, so a stale link fails visibly.
 */

/**
 * The three views the app serves: the geocoder at `/`, the same page with the debug drawer open at `/debug`, and the
 * trace page at `/trace`.
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
	const normalized = pathname.replace(/\/+$/u, "") || "/"

	return ROUTES_BY_PATH.get(normalized) ?? null
}

/**
 * The `?q=` query, decoded, or null when absent or blank. Blank is null so a link that carries `?q=` with nothing after
 * it behaves like a link without it.
 */
export function queryFromSearch(search: string): string | null {
	const value = new URLSearchParams(search).get("q")

	if (value === null) return null

	return value.trim() === "" ? null : value
}
