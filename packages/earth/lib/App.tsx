/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Route → view. The geocoder and the debug view mount the same page; the debug view opens the decode-path drawer
 *   by default, and the trace view mounts the live model visualizer over the same runtime. The page mounts the real
 *   runtime; `?runtime=fake` mounts the canned one the shell smoke and the stories use, so a deployment can be
 *   checked without a model download.
 */

import "maplibre-gl/dist/maplibre-gl.css"
import "@mailwoman/react/styles.css"
import "./styles/app.css"
import { Geocoder } from "@mailwoman/react/map"
import { makeFakeGeocoderRuntime } from "@mailwoman/react/map/fake-runtime"
import { DEFAULT_ADDRESS, EXAMPLE_ADDRESSES } from "mailwoman/browser-runtime/classify"
import { useMemo } from "react"

import { PRODUCTION_CONFIG } from "#config"
import { queryFromSearch, Route, routeForPath, runtimeModeFromSearch } from "#routes"
import { DEFAULT_CENTER, useBrowserGeolocation } from "#runtime/use-browser-geolocation"
import { useGeocoderRuntime } from "#runtime/use-geocoder-runtime"

import { LiveModelVisualizer } from "./explorers/LiveModelVisualizer.tsx"
import { useGeocoderPanels } from "./panels/GeocoderPanels.tsx"

import geocoderStyles from "./panels/geocoder.module.css"
import panelStyles from "./panels/panels.module.css"

const PRESETS = EXAMPLE_ADDRESSES.map((example) => ({ label: example.label, value: example.address }))

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

/**
 * The real geocoder, with the host panels. The map renders at the default centre at once; the geolocation answer moves
 * the bias when it arrives, so nothing waits on the network before the first paint.
 */
function RealGeocoder({ route, query }: { route: Route; query: string | null }) {
	const initialCenter = useBrowserGeolocation(PRODUCTION_CONFIG)

	const handle = useGeocoderRuntime({
		config: PRODUCTION_CONFIG,
		initialCenter: initialCenter ?? DEFAULT_CENTER,
	})

	const panels = useGeocoderPanels({ handle, debugDefault: route === Route.Debug })

	if (route === Route.Trace) {
		return (
			<div className="trace">
				<LiveModelVisualizer
					traceParse={handle.traceParse}
					supportsTrace={handle.supportsTrace}
					ready={handle.runtime.ready}
					loadingProgress={handle.runtime.loading?.progress ?? null}
					errorMessage={handle.runtime.errorMessage ?? null}
				/>
			</div>
		)
	}

	return (
		<Geocoder runtime={handle.runtime} panels={panels} defaultAddress={query ?? DEFAULT_ADDRESS} presets={PRESETS} />
	)
}

function FakeGeocoder({ query }: { query: string | null }) {
	const runtime = useMemo(() => makeFakeGeocoderRuntime(), [])

	return <Geocoder runtime={runtime} defaultAddress={query ?? DEFAULT_ADDRESS} presets={PRESETS} />
}

export function App() {
	const route = routeForPath(location.pathname)
	const query = queryFromSearch(location.search)
	const mode = runtimeModeFromSearch(location.search)

	if (route === null) return <NotFound pathname={location.pathname} />

	return (
		<main className={`${panelStyles.demoRoot} ${geocoderStyles.geocoderRoot}`} data-route={route} data-runtime={mode}>
			{mode === "fake" ? <FakeGeocoder query={query} /> : <RealGeocoder route={route} query={query} />}
		</main>
	)
}
