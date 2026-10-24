/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `?runtime=fake` mounts the canned runtime the shell smoke and the stories use, so a deployment can be checked without a model download.
 */

import "maplibre-gl/dist/maplibre-gl.css"
import "@mailwoman/react/fonts.css"
import "@mailwoman/react/styles.css"
import "./styles/app.css"
import { Geocoder, type GeocoderPanels } from "@mailwoman/react/map"
import { makeFakeGeocoderRuntime } from "@mailwoman/react/map/fake-runtime"
import { DEFAULT_ADDRESS, EXAMPLE_ADDRESSES } from "mailwoman/browser-runtime/classify"
import { useMemo } from "react"

import { PRODUCTION_CONFIG } from "#config"
import {
	cameraFromLocation,
	gazettePlaceFromPath,
	queryFromSearch,
	Route,
	routeForPath,
	runtimeModeFromSearch,
	searchWithQuery,
} from "#routes"
import { DEFAULT_CENTER, useBrowserGeolocation } from "#runtime/use/browser-geolocation"
import {
	type GeocoderRuntimeHandle,
	type GeocoderRuntimeOptions,
	useGeocoderRuntime,
} from "#runtime/use/geocoder-runtime"
import { remoteGeocoderURL, useRemoteGeocoderRuntime } from "#runtime/use/remote-geocoder-runtime"

import { GazettePage } from "./explorers/Gazette/GazettePage.tsx"
import { LiveModelVisualizer } from "./explorers/LiveModelVisualizer.tsx"
import { EarthFooter } from "./panels/EarthFooter.tsx"
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
 * The map renders at the default center at once.
 *
 * The geolocation answer only moves the bias when it arrives, so no request
 * waits on the network before the first paint.
 */
function useRuntimeOptions(): GeocoderRuntimeOptions {
	const initialCenter = useBrowserGeolocation(PRODUCTION_CONFIG)
	const camera = cameraFromLocation(location.pathname, location.search)

	return {
		config: PRODUCTION_CONFIG,
		initialCenter: camera?.center ?? initialCenter ?? DEFAULT_CENTER,
		initialZoom: camera?.zoom ?? undefined,
	}
}

function LocalGeocoder({ route, query }: { route: Route; query: string | null }) {
	const handle = useGeocoderRuntime(useRuntimeOptions())

	return <GeocoderView handle={handle} route={route} query={query} />
}

function RemoteGeocoder({ apiURL, route, query }: { apiURL: URL; route: Route; query: string | null }) {
	const handle = useRemoteGeocoderRuntime(apiURL, useRuntimeOptions())

	return <GeocoderView handle={handle} route={route} query={query} />
}

function GeocoderView({ handle, route, query }: { handle: GeocoderRuntimeHandle; route: Route; query: string | null }) {
	const panels = useGeocoderPanels({ handle, debugDefault: route === Route.Debug })

	return (
		<Geocoder
			runtime={handle.runtime}
			panels={panels}
			defaultAddress={query ?? DEFAULT_ADDRESS}
			// `defaultAddress` only pre-fills the field, so only the URL's query goes to
			// `initialQuery`; a cold visit still pre-fills the demo address without resolving it.
			initialQuery={query}
			presets={PRESETS}
			// `/debug` exists to show the model's intermediate outputs, so it opens
			// the disclosure the default view collapses.
			developer={route === Route.Debug}
			onSubmitQuery={writeQueryToURL}
		/>
	)
}

/**
 * The trace workbench has no map.
 *
 * It loads the classifier through the same runtime hook as the geocoder,
 * so the release's assets are shared with the map page's cache, and it skips the
 * geolocation request and the map panels the geocoder needs.
 */
function TracePage({ query }: { query: string | null }) {
	const handle = useGeocoderRuntime({ config: PRODUCTION_CONFIG, initialCenter: DEFAULT_CENTER })

	return (
		<div className="trace">
			<LiveModelVisualizer
				traceParse={handle.traceParse}
				supportsTrace={handle.supportsTrace}
				ready={handle.runtime.ready}
				loadingProgress={handle.runtime.loading?.progress ?? null}
				errorMessage={handle.runtime.errorMessage ?? null}
				initialText={query}
				onTextTraced={writeQueryToURL}
			/>
		</div>
	)
}

/**
 * `replaceState`, not `pushState`, so the back button does not walk every submitted query.
 */
function writeQueryToURL(query: string): void {
	history.replaceState(history.state, "", searchWithQuery(new URL(location.href), query))
}

/**
 * The app's identity and source credits belong to the page rather than the runtime,
 * so the canned runtime shows the same footer as the real one.
 */
const IDENTITY_PANELS: GeocoderPanels = {
	footer: <EarthFooter />,
}

function FakeGeocoder({ query }: { query: string | null }) {
	const runtime = useMemo(() => makeFakeGeocoderRuntime(), [])

	return (
		<Geocoder runtime={runtime} panels={IDENTITY_PANELS} defaultAddress={query ?? DEFAULT_ADDRESS} presets={PRESETS} />
	)
}

export function App() {
	const route = routeForPath(location.pathname)
	const query = queryFromSearch(location.search)
	const mode = runtimeModeFromSearch(location.search)
	const apiURL = remoteGeocoderURL(PRODUCTION_CONFIG)

	if (!route) return <NotFound pathname={location.pathname} />

	// The gazette reads the gazetteer without the classifier and has no canned runtime, so it ignores the runtime mode.
	if (route === Route.Gazette) {
		return (
			<main className={`${panelStyles.demoRoot} ${geocoderStyles.geocoderRoot}`} data-route={route}>
				<div className="gazette">
					<GazettePage config={PRODUCTION_CONFIG} query={query} place={gazettePlaceFromPath(location.pathname)} />
				</div>
			</main>
		)
	}

	return (
		<main className={`${panelStyles.demoRoot} ${geocoderStyles.geocoderRoot}`} data-route={route} data-runtime={mode}>
			{mode === "fake" ? (
				<FakeGeocoder query={query} />
			) : route === Route.Trace ? (
				<TracePage query={query} />
			) : apiURL ? (
				<RemoteGeocoder apiURL={apiURL} route={route} query={query} />
			) : (
				<LocalGeocoder route={route} query={query} />
			)}
		</main>
	)
}
