/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The body's app: the host check first, then the route. A production host serving the other body's build renders
 *   the error rather than the other world, so a misconfigured Workers Builds project is visible on its first load.
 *   The selection IS the route: a click pushes `/feature/<id>`, a deep link restores the feature from the search
 *   artifact, and the browser's back button is the close button.
 */

import "maplibre-gl/dist/maplibre-gl.css"
import "@mailwoman/react/fonts.css"
import "@mailwoman/react/styles.css"
import "./styles/app.css"
import { useCallback, useEffect, useMemo, useState } from "react"

import { BODY_CONFIGS } from "#bodies/index"
import { assertHostMatchesBody, currentBody } from "#body"
import type { SelectedFeature } from "#features/selected"
import { PlanetaryMap } from "#map/PlanetaryMap"
import { Attribution } from "#panels/Attribution"
import { FeaturePanel } from "#panels/FeaturePanel"
import { pathForRoute, type PlanetaryRoute, routeForPath } from "#routes"
import type { SearchHit } from "#search/index"
import { SearchBox } from "#search/SearchBox"
import { useSearchIndex } from "#search/useSearchIndex"

function NotFound({ pathname, title }: { pathname: string; title: string }) {
	return (
		<section className="not-found" data-testid="not-found">
			<h1>Not here</h1>
			<p>
				<code>{pathname}</code> is not a page of {title}. <a href="/">Go to the globe.</a>
			</p>
		</section>
	)
}

function WrongBody({ message }: { message: string }) {
	return (
		<section className="not-found" data-testid="wrong-body">
			<h1>Wrong world</h1>
			<p>{message}</p>
		</section>
	)
}

/**
 * A search hit as a selection. `diameterKm` rides along because the camera frames by it, and without it every search
 * result and every deep link landed on the smallest-feature zoom — a 4,000 km canyon framed as tightly as a 3 km
 * crater, past the resolution the terrain archive carries.
 */
function featureFromHit(hit: SearchHit): SelectedFeature {
	return {
		id: hit.id,
		name: hit.name,
		featureType: hit.featureType,
		featureTypeCode: hit.featureTypeCode,
		diameterKm: hit.diameterKm,
		centerLon: hit.centerLon,
		centerLat: hit.centerLat,
	}
}

export function App() {
	const body = currentBody()
	const config = BODY_CONFIGS[body]

	const [route, setRoute] = useState<PlanetaryRoute | null>(() => routeForPath(location.pathname))
	// The feature most recently picked from a click or a search hit. A click carries the archive's whole record,
	// which the artifact does not, so it is kept beside the route rather than re-read from the artifact.
	const [picked, setPicked] = useState<SelectedFeature | null>(null)
	const search = useSearchIndex(config.artifacts.searchIndexURL)

	useEffect(() => {
		document.title = config.title
	}, [config.title])

	useEffect(() => {
		const onPopState = () => setRoute(routeForPath(location.pathname))

		addEventListener("popstate", onPopState)

		return () => removeEventListener("popstate", onPopState)
	}, [])

	const navigate = useCallback((next: PlanetaryRoute) => {
		history.pushState(null, "", pathForRoute(next))
		setRoute(next)
	}, [])

	const select = useCallback(
		(feature: SelectedFeature) => {
			setPicked(feature)
			navigate({ kind: "feature", id: feature.id })
		},
		[navigate]
	)

	const close = useCallback(() => navigate({ kind: "map" }), [navigate])

	const selected = useMemo<SelectedFeature | null>(() => {
		if (route?.kind !== "feature") return null

		if (picked?.id === route.id) return picked

		const hit = search.index?.byID(route.id)

		return hit ? featureFromHit(hit) : null
	}, [route, picked, search.index])

	try {
		assertHostMatchesBody(location.hostname, body)
	} catch (error) {
		return <WrongBody message={(error as Error).message} />
	}

	if (route === null) return <NotFound pathname={location.pathname} title={config.title} />

	return (
		<main data-route={route.kind} data-body={body} data-search={search.status}>
			<h1 className="visually-hidden">{config.title}</h1>
			<PlanetaryMap config={config} selected={selected} onSelect={select} />
			<div className="search-slot">
				<SearchBox
					search={search.index}
					placeholder={
						search.status === "failed" ? "Search is unavailable" : `Search ${config.title.replace("Mailwoman ", "")}`
					}
					onSelect={(hit) => select(featureFromHit(hit))}
				/>
			</div>
			{selected ? <FeaturePanel feature={selected} latitudeType={config.latitudeType} onClose={close} /> : null}
			{route.kind === "feature" && !selected && search.status === "ready" ? (
				<section className="feature-panel" data-testid="feature-missing">
					<p>
						No feature <code>{route.id}</code> in this archive. <a href="/">Go to the globe.</a>
					</p>
				</section>
			) : null}
			<Attribution config={config} />
		</main>
	)
}
