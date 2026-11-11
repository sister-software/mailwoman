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
import type { ParseResult } from "@mailwoman/core/pipeline/client-result"
import { Geocoder, type GeocoderPanels } from "@mailwoman/react/map"
import { makeFakeGeocoderRuntime } from "@mailwoman/react/map/fake-runtime"
import { ReachabilityProvider } from "@mailwoman/react/network/ReachabilityProvider"
import { EXAMPLE_ADDRESSES } from "mailwoman/browser-runtime/classify"
import { useCallback, useEffect, useMemo, useState } from "react"

import { PRODUCTION_CONFIG } from "#config"
import { pageTitle } from "#page-title"
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
import {
	remoteGeocoderHealthURL,
	remoteGeocoderURL,
	useRemoteGeocoderRuntime,
} from "#runtime/use/remote-geocoder-runtime"

import { GazettePage } from "./explorers/Gazette/GazettePage.tsx"
import { LiveModelVisualizer } from "./explorers/LiveModelVisualizer.tsx"
import { EarthFooter } from "./panels/EarthFooter.tsx"
import { useGeocoderPanels } from "./panels/GeocoderPanels.tsx"

import geocoderStyles from "./panels/geocoder.module.css"
import panelStyles from "./panels/panels.module.css"

const PRESETS = EXAMPLE_ADDRESSES.map((example) => ({ label: example.label, value: example.address }))

/**
 * The empty field's placeholder: an address, a place name, or any point shape the parser reads.
 */
const PLACEHOLDER = "Search an address, a place or coordinates"

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

/**
 * The query the URL names, kept in step with the history: a submit records a new entry,
 * and the back and forward buttons restore the entry's query.
 */
interface URLQuery {
	query: string | null
	/**
	 * Record a submitted query as a history entry, or remove the query for an emptied field.
	 */
	record: (query: string) => void
}

function useURLQuery(): URLQuery {
	const [query, setQuery] = useState(() => queryFromSearch(location.search))

	useEffect(() => {
		const onPopState = () => setQuery(queryFromSearch(location.search))

		addEventListener("popstate", onPopState)

		return () => removeEventListener("popstate", onPopState)
	}, [])

	const record = useCallback((next: string) => {
		writeQueryToURL(next)
		setQuery(next.trim() === "" ? null : next)
	}, [])

	return { query, record }
}

function LocalGeocoder({ route, url }: { route: Route; url: URLQuery }) {
	const handle = useGeocoderRuntime(useRuntimeOptions())

	return <GeocoderView handle={handle} route={route} url={url} />
}

function RemoteGeocoder({ apiURL, route, url }: { apiURL: URL; route: Route; url: URLQuery }) {
	return (
		<ReachabilityProvider url={remoteGeocoderHealthURL(apiURL)}>
			<RemoteGeocoderView apiURL={apiURL} route={route} url={url} />
		</ReachabilityProvider>
	)
}

function RemoteGeocoderView({ apiURL, route, url }: { apiURL: URL; route: Route; url: URLQuery }) {
	const handle = useRemoteGeocoderRuntime(apiURL, useRuntimeOptions())

	return <GeocoderView handle={handle} route={route} url={url} />
}

function GeocoderView({ handle, route, url }: { handle: GeocoderRuntimeHandle; route: Route; url: URLQuery }) {
	const panels = useGeocoderPanels({ handle, debugDefault: route === Route.Debug })

	return (
		<Geocoder
			runtime={handle.runtime}
			panels={panels}
			// The URL's query pre-fills the field and is submitted.
			// A cold visit opens an empty field.
			defaultAddress={url.query ?? ""}
			placeholder={PLACEHOLDER}
			query={url.query}
			presets={PRESETS}
			// `/debug` exists to show the model's intermediate outputs, so it opens
			// the disclosure the default view collapses.
			developer={route === Route.Debug}
			onSubmitQuery={url.record}
			onResult={titleAfterResult}
		/>
	)
}

/**
 * The tab reads as the matched place.
 */
function titleAfterResult(result: ParseResult | null): void {
	document.title = pageTitle(result?.resolved?.name ?? null)
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
				onTextTraced={replaceQueryInURL}
			/>
		</div>
	)
}

/**
 * Each submitted query is a history entry, as on Google Maps, so the back
 * button returns to the previous search.
 *
 * An emptied field isn't a search, so it rewrites the entry instead, and a query
 * equal to the URL's leaves the history as it is.
 */
function writeQueryToURL(query: string): void {
	const next = searchWithQuery(new URL(location.href), query)

	if (next === `${location.pathname}${location.search}${location.hash}`) return

	if (query.trim() === "") {
		history.replaceState(history.state, "", next)
	} else {
		history.pushState(history.state, "", next)
	}
}

/**
 * The trace workbench writes the traced text on every keystroke, so it rewrites the entry
 * rather than adding one per keystroke.
 */
function replaceQueryInURL(query: string): void {
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
		<Geocoder
			runtime={runtime}
			panels={IDENTITY_PANELS}
			defaultAddress={query ?? ""}
			placeholder={PLACEHOLDER}
			presets={PRESETS}
		/>
	)
}

export function App() {
	const route = routeForPath(location.pathname)
	const url = useURLQuery()
	const { query } = url
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
				<RemoteGeocoder apiURL={apiURL} route={route} url={url} />
			) : (
				<LocalGeocoder route={route} url={url} />
			)}
		</main>
	)
}
