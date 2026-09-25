/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Compose the map, controls, runtime hooks, and host-provided panels.
 *   Render behind a client-only boundary because the map requires browser APIs.
 *   Import from `@mailwoman/react/map`; this module depends on MapLibre.
 */

import { type ReactNode, useCallback, useEffect, useRef, useState } from "react"
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
 * Configures {@linkcode Geocoder} with the host-injected runtime and panels,
 * plus optional presets, an initial query, and camera and bias behavior.
 */
export interface GeocoderProps {
	/**
	 * The injected geocoder runtime (map style + overlays + parse + version/backend).
	 */
	runtime: GeocoderRuntime
	/**
	 * Host-injected panels (about, release blurb, compare, permalink, debug drawer, map controls, …).
	 */
	panels?: GeocoderPanels
	/**
	 * Address to pre-fill.
	 */
	defaultAddress?: string
	/**
	 * A query that arrived with the page — a permalink's `?q=`, say —
	 * to run once as soon as the runtime is ready.
	 *
	 * Distinct from {@link GeocoderProps.defaultAddress}, and deliberately so: a cold visit
	 * pre-fills the demo address but must not spend a visitor's first seconds resolving an
	 * address they did not ask for, while a link someone was sent has to answer on arrival.
	 * Without this, a permalink pre-filled the field and then sat on a world view with the
	 * address never run, which made "Copy link" produce a link that did not reproduce the result.
	 */
	initialQuery?: string | null
	/**
	 * Example chips. @default the empty set (host supplies its own).
	 */
	presets?: ReadonlyArray<Preset>
	/**
	 * Open the developer disclosure on mount — the model version, the backend readout and compare.
	 *
	 * Collapsed by default so the address field is the first thing a visitor meets. @default false
	 */
	developer?: boolean
	/**
	 * Fired with the query each time one is submitted.
	 *
	 * The host writes it into its own URL.
	 * This package never touches `location`, because which parameter carries a query is the app's decision.
	 */
	onSubmitQuery?: (query: string) => void
	/**
	 * Only hint the viewport bias once the visitor has zoomed past the global view.
	 * A whole-globe center is noise.
	 *
	 * Matches the `map.getZoom() >= 4` threshold. @default 4
	 */
	minBiasZoom?: number
	/**
	 * Fly/fit the map to the resolved place on each result (via {@link ResolvedPlaceLayers}). @default true.
	 *
	 * Set false for a host that drives the camera itself (a controlled `<MapCanvas viewState>`),
	 * or to keep a headless test deterministic.
	 * The marker + outline still render, only the animated camera move is skipped.
	 */
	applyResultCamera?: boolean
}

interface GeocoderInnerProps extends Required<
	Pick<GeocoderProps, "runtime" | "defaultAddress" | "minBiasZoom" | "applyResultCamera" | "developer">
> {
	panels: GeocoderPanels
	presets: ReadonlyArray<Preset>
	initialQuery: string | null
	onSubmitQuery?: (query: string) => void
}

function GeocoderInner({
	runtime,
	panels,
	defaultAddress,
	presets,
	minBiasZoom,
	applyResultCamera,
	developer,
	initialQuery,
	onSubmitQuery,
}: GeocoderInnerProps): ReactNode {
	const mapRef = useRef<MapRef>(null)
	// The chrome sits outside `<MapCanvas>`, so it cannot take the handle from `useMap()`.
	// A ref alone does not re-render the compass or the layer control when the map arrives,
	// so the same poll that publishes the test handle also puts it in state — one poll, two consumers.
	const [map, setMap] = useState<ReturnType<MapRef["getMap"]> | null>(null)

	// Publish the loaded map for browser tests and controls.
	// Place the graticule above the background and below data layers.
	const [baseLayerID, setBaseLayerID] = useState<string | undefined>(undefined)

	const onMapLoad = useCallback((event: { target: ReturnType<MapRef["getMap"]> }) => {
		;(globalThis as { __mailwomanMapCanvas?: ReturnType<MapRef["getMap"]> }).__mailwomanMapCanvas = event.target
		setMap(event.target)

		const layers = event.target.getStyle()?.layers ?? []

		setBaseLayerID(layers.find((layer) => layer.type !== "background")?.id)
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

	const onForceWASMChange = useCallback((forceWASM: boolean) => runtime.setForceWASM?.(forceWASM), [runtime])

	return (
		<div className="mw-geocoder-demo">
			<div className="mw-geocoder-demo__map">
				<MapCanvas
					mapStyle={runtime.mapStyle}
					mapRef={mapRef}
					initialViewState={{
						longitude: runtime.initialCenter[0],
						latitude: runtime.initialCenter[1],
						zoom: runtime.initialZoom ?? 3,
					}}
					style={{ width: "100%", height: "100%" }}
					// One compact attribution pill (the map's own default is a wide, always-open "MapLibre | © …" bar), no maplibre wordmark logo.
					mapProps={{ attributionControl: { compact: true }, maplibreLogo: false, onLoad: onMapLoad }}
				>
					<GraticuleLayer beforeID={baseLayerID} />
					<OverlayLayers overlays={runtime.overlays} />
					<ResolvedPlaceLayers spec={spec} applyCamera={applyResultCamera} />
					{panels.mapControls}
				</MapCanvas>
			</div>

			<GeocoderControls
				runtime={runtime}
				geocode={geocode}
				autocomplete={autocomplete}
				compare={compare}
				panels={panels}
				presets={presets}
				placeholder={defaultAddress}
				initialQuery={initialQuery}
				map={map}
				onSubmitQuery={onSubmitQuery}
				onSelectVersion={onSelectVersion}
				onForceWASMChange={onForceWASMChange}
				developer={developer}
			/>
			{panels.debugDrawer ? panels.debugDrawer({ result: geocode.result }) : null}
		</div>
	)
}

/**
 * Stable empty defaults — a fresh `{}`/`[]` per render would churn every downstream memo dep.
 */
const NO_PANELS: GeocoderPanels = {}
const NO_PRESETS: ReadonlyArray<Preset> = []

/**
 * The composed geocoder, behind a `ClientOnly` SSR boundary (the map is intrinsically a client component).
 */
export function Geocoder({
	runtime,
	panels = NO_PANELS,
	defaultAddress = "",
	presets = NO_PRESETS,
	minBiasZoom = 4,
	applyResultCamera = true,
	developer = false,
	initialQuery = null,
	onSubmitQuery,
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
					presets={presets}
					minBiasZoom={minBiasZoom}
					applyResultCamera={applyResultCamera}
					developer={developer}
					initialQuery={initialQuery}
					onSubmitQuery={onSubmitQuery}
				/>
			)}
		</ClientOnly>
	)
}
