/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The body's app: the host check first, then the route, so a production host serving the other body's build
 *   renders the error on its first load; a click pushes `/feature/<id>` and the browser's back button closes it.
 */

import "maplibre-gl/dist/maplibre-gl.css"
import "@mailwoman/react/fonts.css"
import "@mailwoman/react/styles.css"
import "./styles/app.css"
import { MapChipRow } from "@mailwoman/react/map/MapChipRow"
import { MapCompass } from "@mailwoman/react/map/MapCompass"
import { MapControlButton, MapControlGroup, MapControlStack } from "@mailwoman/react/map/MapControlStack"
import { MapSheet } from "@mailwoman/react/map/MapSheet"
import { useMapBearing } from "@mailwoman/react/map/useMapBearing"
import { useCallback, useEffect, useMemo, useState } from "react"
import type { MapInstance } from "react-map-gl/maplibre"

import { BODY_CONFIGS } from "#bodies/index"
import { assertHostMatchesBody, currentBody } from "#body"
import type { SelectedFeature } from "#features/selected"
import { PlanetaryMap } from "#map/PlanetaryMap"
import { Attribution } from "#panels/Attribution"
import { BodyAbout } from "#panels/BodyAbout"
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
 * A search hit as a selection; `diameterKm` rides along because the camera frames by it.
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
	// The feature most recently picked: a click carries the archive's whole record,
	// which the artifact lacks, so it is kept beside the route rather than re-read.
	const [picked, setPicked] = useState<SelectedFeature | null>(null)
	const search = useSearchIndex(config.artifacts.searchIndexURL)
	const [map, setMap] = useState<MapInstance | null>(null)
	const [aboutOpen, setAboutOpen] = useState(false)

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

	// A chip names a feature; only an exact name match selects it, never the closest other feature.
	const pickByName = useCallback(
		(name: string) => {
			const hit = search.index?.query(name, 1).find((candidate) => candidate.name === name)

			if (hit) {
				select(featureFromHit(hit))
			}
		},
		[search.index, select]
	)

	const { bearing, resetNorth } = useMapBearing(map)
	const closeAbout = useCallback(() => setAboutOpen(false), [setAboutOpen])

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
			<PlanetaryMap config={config} selected={selected} onSelect={select} onMapReady={setMap} />
			<div className="search-slot">
				<SearchBox
					search={search.index}
					placeholder={search.status === "failed" ? "Search is unavailable" : `Search ${config.displayName}`}
					onSelect={(hit) => select(featureFromHit(hit))}
				/>

				<MapChipRow
					chips={config.exampleFeatures.map((name) => ({ label: name, value: name }))}
					label={`Example features on ${config.displayName}`}
					disabled={search.status !== "ready"}
					onPick={pickByName}
				/>
			</div>

			{/* Every floating control in one column, so no control lands on top of anything else. */}
			<MapControlStack label="Map controls">
				<MapControlGroup>
					<MapControlButton
						label={`About ${config.displayName}`}
						active={aboutOpen}
						onPress={() => setAboutOpen((value) => !value)}
					>
						<span aria-hidden="true">i</span>
					</MapControlButton>
				</MapControlGroup>

				<MapControlGroup className="mw-map-control-group--compass">
					<MapCompass bearing={bearing} onResetNorth={resetNorth} />
				</MapControlGroup>
			</MapControlStack>

			{aboutOpen ? (
				<MapSheet title={`About ${config.displayName}`} onClose={closeAbout}>
					<BodyAbout config={config} />
				</MapSheet>
			) : null}

			{selected ? <FeaturePanel feature={selected} latitudeType={config.latitudeType} onClose={close} /> : null}
			{route.kind === "feature" && !selected && search.status === "ready" ? (
				<MapSheet title="Not in this archive" onClose={close} className="feature-panel">
					<p data-testid="feature-missing">
						No feature <code>{route.id}</code> in this archive. <a href="/">Go to the globe.</a>
					</p>
				</MapSheet>
			) : null}
			<Attribution config={config} />
		</main>
	)
}
