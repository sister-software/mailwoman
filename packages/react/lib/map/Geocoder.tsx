/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
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
 * Props for {@linkcode Geocoder}.
 */
export interface GeocoderProps {
	/**
	 * The geocoder runtime, which supplies the map style, overlays, parser, and version and backend controls.
	 */
	runtime: GeocoderRuntime
	/**
	 * Panels supplied by the host.
	 */
	panels?: GeocoderPanels
	/**
	 * The address that pre-fills the search field.
	 * It is not run automatically.
	 */
	defaultAddress?: string
	/**
	 * A query to run once when the runtime is ready, such as a permalink's `?q=` value.
	 *
	 * Unlike {@link GeocoderProps.defaultAddress}, this query is submitted,
	 * so a shared link reproduces its result.
	 */
	initialQuery?: string | null
	/**
	 * The example chips.
	 *
	 * @default []
	 */
	presets?: ReadonlyArray<Preset>
	/**
	 * Whether the developer panel starts open.
	 *
	 * @default false
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
	 * @default 4
	 */
	minBiasZoom?: number
	/**
	 * Whether the map moves to each resolved place.
	 *
	 * Set it to false when the host controls the camera or a test needs a fixed view.
	 * The marker and outline render either way.
	 *
	 * @default true
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
	// The controls render outside `<MapCanvas>` and cannot call `useMap()`.
	// The map is kept in state so they re-render when it loads.
	const [map, setMap] = useState<ReturnType<MapRef["getMap"]> | null>(null)

	// The graticule is inserted before the first non-background layer, so it draws under the data layers.
	const [baseLayerID, setBaseLayerID] = useState<string | undefined>(undefined)

	const onMapLoad = useCallback((event: { target: ReturnType<MapRef["getMap"]> }) => {
		// Browser tests read the map from this global.
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
					// The attribution is compact, and the MapLibre logo is hidden.
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

// These defaults are module constants so each render sees the same reference and memo dependencies stay stable.
const NO_PANELS: GeocoderPanels = {}
const NO_PRESETS: ReadonlyArray<Preset> = []

/**
 * Renders the map, search controls, and host panels as one geocoder.
 *
 * It renders only on the client because MapLibre needs browser APIs.
 * Import it from `@mailwoman/react/map`.
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
