/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Route → view. The geocoder and the debug view mount the same page; the debug view opens the drawer by default.
 *   This shell mounts the FAKE runtime: canned parse and resolve, an offline map style. The real runtime replaces
 *   `makeDemoRuntime()` when it moves in from the docs site, and nothing else here changes.
 */

import "maplibre-gl/dist/maplibre-gl.css"
import "@mailwoman/react/styles.css"
import "./styles/app.css"
import { GeocoderDemo } from "@mailwoman/react/map"
import { makeDemoRuntime } from "@mailwoman/react/map/fake-runtime"
import { useMemo } from "react"

import { queryFromSearch, routeForPath } from "#routes"

const PRESETS = [
	{ label: "White House", value: "1600 Pennsylvania Ave NW, Washington, DC 20500" },
	{ label: "Empire State", value: "350 5th Ave, New York, NY 10118" },
	{ label: "ZIP only", value: "90210" },
]

const DEFAULT_ADDRESS = "1600 Pennsylvania Ave NW, Washington, DC 20500"

function NotFound({ pathname }: { pathname: string }) {
	return (
		<section className="not-found" data-testid="not-found">
			<h1>Not here</h1>
			<p>
				<code>{pathname}</code> is not a page of Mailwoman Earth. <a href="/">Go to the geocoder.</a>
			</p>
		</section>
	)
}

export function App() {
	const route = routeForPath(location.pathname)
	const query = queryFromSearch(location.search)
	const runtime = useMemo(() => makeDemoRuntime(), [])

	if (route === null) return <NotFound pathname={location.pathname} />

	return (
		<main data-route={route}>
			<GeocoderDemo runtime={runtime} defaultAddress={query ?? DEFAULT_ADDRESS} presets={PRESETS} />
		</main>
	)
}
