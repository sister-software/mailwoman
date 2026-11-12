// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import type { ParseResult } from "@mailwoman/core/pipeline/client-result"
import { type ReactNode, useCallback, useEffect, useEffectEvent, useRef, useState } from "react"
import type { MapRef } from "react-map-gl/maplibre"

import type { GeocoderPanels, GeocoderRuntime, MapBias } from "#map/types"
import { useCompareState } from "#map/useCompareState"
import { useGeocode } from "#map/useGeocode"
import { useMapPlaceRender } from "#map/useMapPlaceRender"
import { usePlaceAutocomplete } from "#map/usePlaceAutocomplete"

import { ClientOnly } from "../common/ClientOnly.tsx"
import type { Preset } from "../common/PresetChips.tsx"
import { GeocoderControls } from "./GeocoderControls.tsx"
import { GraticuleLayer } from "./GraticuleLayer.tsx"
import { MapCanvas } from "./MapCanvas.tsx"
import { OverlayLayers } from "./OverlayLayers.tsx"
import { ResolvedPlaceLayers } from "./ResolvedPlaceLayers.tsx"

/**
 * Props for {@linkcode Geocoder}.
 */
export interface GeocoderProps {
	/**
	 * The geocoder runtime supplies the map style and overlays.
	 *
	 * It also supplies the parser and version and backend controls.
	 */
	runtime: GeocoderRuntime
	/**
	 * Panels supplied by the host.
	 */
	panels?: GeocoderPanels
	/**
	 * The address that pre-fills the search field.
	 * It isn't run automatically.
	 */
	defaultAddress?: string
	/**
	 * The field's placeholder while it is empty.
	 *
	 * @defaultValue `"Search an address or place"`
	 */
	placeholder?: string
	/**
	 * The query the host's URL names, such as a permalink's `?q=` value.
	 *
	 * Unlike {@link GeocoderProps.defaultAddress}, this query is submitted,
	 * so a shared link reproduces its result.
	 * Each new value is submitted once the runtime is ready, so a host that reads its URL
	 * on `popstate` lets the back and forward buttons re-run earlier searches.
	 *
	 * A value equal to the last submitted query isn't submitted again.
	 */
	query?: string | null
	/**
	 * Called with each parse result, and with `null` when the result is cleared.
	 *
	 * The host decides what to do with it, such as setting the document title.
	 */
	onResult?: (result: ParseResult | null) => void
	/**
	 * The example chips.
	 *
	 * @defaultValue []
	 */
	presets?: ReadonlyArray<Preset>
	/**
	 * Whether the developer panel starts open.
	 *
	 * @defaultValue `false`
	 */
	developer?: boolean
	/**
	 * Called with each user-submitted query.
	 *
	 * The host decides how to write the query to its URL.
	 * This package never touches `location`.
	 */
	onSubmitQuery?: (query: string) => void
	/**
	 * The minimum map zoom at which the viewport is sent as a location bias.
	 *
	 * @defaultValue `4`
	 */
	minBiasZoom?: number
	/**
	 * Whether the map moves to each resolved place.
	 *
	 * Set it to false when the host controls the camera or a test needs a fixed view.
	 * The marker and outline render either way.
	 *
	 * @defaultValue `true`
	 */
	applyResultCamera?: boolean
}

interface GeocoderInnerProps extends Required<
	Pick<GeocoderProps, "runtime" | "defaultAddress" | "placeholder" | "minBiasZoom" | "applyResultCamera" | "developer">
> {
	panels: GeocoderPanels
	presets: ReadonlyArray<Preset>
	query: string | null
	onSubmitQuery?: (query: string) => void
	onResult?: (result: ParseResult | null) => void
}

function GeocoderInner({
	runtime,
	panels,
	defaultAddress,
	placeholder,
	presets,
	minBiasZoom,
	applyResultCamera,
	developer,
	query,
	onSubmitQuery,
	onResult,
}: GeocoderInnerProps): ReactNode {
	const mapRef = useRef<MapRef>(null)
	// The controls render outside `<MapCanvas>` and cannot call `useMap()`.
	// The map is kept in state so they re-render when it loads.
	const [map, setMap] = useState<ReturnType<MapRef["getMap"]> | null>(null)

	// The graticule is inserted before the first non-background layer, so it draws under the data layers.
	const [baseLayerID, setBaseLayerID] = useState<string | undefined>(undefined)

	// Overlays are inserted before the first label layer, so place names stay readable over a fill.
	const [labelLayerID, setLabelLayerID] = useState<string | undefined>(undefined)

	const onMapLoad = useCallback((event: { target: ReturnType<MapRef["getMap"]> }) => {
		// Browser tests read the map from this global.
		;(globalThis as { __mailwomanMapCanvas?: ReturnType<MapRef["getMap"]> }).__mailwomanMapCanvas = event.target
		setMap(event.target)

		const layers = event.target.getStyle()?.layers ?? []

		setBaseLayerID(layers.find((layer) => layer.type !== "background")?.id)
		setLabelLayerID(layers.find((layer) => layer.type === "symbol")?.id)
	}, [])

	useEffect(
		() => () => {
			setMap(null)
			delete (globalThis as { __mailwomanMapCanvas?: ReturnType<MapRef["getMap"]> }).__mailwomanMapCanvas
		},
		[]
	)

	const getBias = useCallback((): MapBias | null => {
		const live = mapRef.current?.getMap()

		if (!live) return null
		const zoom = live.getZoom()

		if (zoom < minBiasZoom) return null
		const center = live.getCenter()

		return { center: [center.lng, center.lat], zoom }
	}, [minBiasZoom])

	const geocode = useGeocode({ runtime, defaultText: defaultAddress, getBias })
	const compare = useCompareState()

	// The host hears each result as it lands, including the `null` a reset leaves.
	const reportResult = useEffectEvent((result: ParseResult | null) => onResult?.(result))

	useEffect(() => {
		reportResult(geocode.result)
	}, [geocode.result])

	const autocomplete = usePlaceAutocomplete({
		text: geocode.text,
		setText: geocode.setText,
		autocomplete: runtime.autocomplete,
	})

	const spec = useMapPlaceRender(geocode.mapPlace)

	const onSelectVersion = useCallback(
		(version: string) => {
			runtime.selectVersion?.(version)
			compare.clearIfPrimary(version)
		},
		[runtime, compare]
	)

	return (
		<div className="mw-geocoder-demo">
			<div className="mw-geocoder-demo__map">
				{runtime.mapStyle ? (
					<MapCanvas
						mapStyle={runtime.mapStyle}
						mapRef={mapRef}
						initialViewState={{
							longitude: runtime.initialCenter[0],
							latitude: runtime.initialCenter[1],
							zoom: runtime.initialZoom ?? 3,
						}}
						style={{ width: "100%", height: "100%" }}
						starfield
						// The attribution is compact.
						// The MapLibre logo is hidden.
						mapProps={{
							attributionControl: { compact: true },
							maplibreLogo: false,
							onLoad: onMapLoad,
							maxTileCacheSize: TILE_CACHE_SIZE,
						}}
					>
						<GraticuleLayer beforeID={baseLayerID} />
						<OverlayLayers overlays={runtime.overlays} beforeID={labelLayerID} />
						{/* A pinned place came from a click on the map, so the camera stays where the visitor put it. */}
						<ResolvedPlaceLayers spec={spec} applyCamera={applyResultCamera && !geocode.pinned} />
						{panels.mapControls}
					</MapCanvas>
				) : null}
			</div>

			<GeocoderControls
				runtime={runtime}
				geocode={geocode}
				autocomplete={autocomplete}
				compare={compare}
				panels={panels}
				presets={presets}
				placeholder={placeholder}
				query={query}
				map={map}
				onSubmitQuery={onSubmitQuery}
				onSelectVersion={onSelectVersion}
				developer={developer}
			/>
			{panels.debugDrawer ? panels.debugDrawer({ result: geocode.result }) : null}
		</div>
	)
}

/**
 * The most tiles MapLibre keeps per source for tiles that have left the view.
 *
 * MapLibre otherwise sizes this cache from the viewport.
 * On a tilted street view over dense building extrusions that kept about 1.2 MB of buffers
 * per cached tile, 64 MB for 52 tiles over central Osaka, all of them out of view.
 */
const TILE_CACHE_SIZE = 16

// These defaults are module constants so each render sees the same reference and memo dependencies stay stable.
const NO_PANELS: GeocoderPanels = {}
const NO_PRESETS: ReadonlyArray<Preset> = []

/**
 * Renders the map and search controls as one geocoder.
 * It also renders host panels.
 *
 * It renders only on the client because MapLibre needs browser APIs.
 * Import it from `@mailwoman/react/map`.
 */
export function Geocoder({
	runtime,
	panels = NO_PANELS,
	defaultAddress = "",
	placeholder = "Search an address or place",
	presets = NO_PRESETS,
	minBiasZoom = 4,
	applyResultCamera = true,
	developer = false,
	query = null,
	onSubmitQuery,
	onResult,
}: GeocoderProps): ReactNode {
	return (
		<ClientOnly
			fallback={
				<div className="mw-geocoder-demo">
					<p>Loading the geocoder…</p>
				</div>
			}
		>
			{() => (
				<GeocoderInner
					runtime={runtime}
					panels={panels}
					defaultAddress={defaultAddress}
					placeholder={placeholder}
					presets={presets}
					minBiasZoom={minBiasZoom}
					applyResultCamera={applyResultCamera}
					developer={developer}
					query={query}
					onSubmitQuery={onSubmitQuery}
					onResult={onResult}
				/>
			)}
		</ClientOnly>
	)
}
