/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `<Geocoder>` — the WHOLE geocoder, composed. It is the map analogue of `PipelineExplorer`
 *   and takes the SAME DI shape: an injected {@link GeocoderRuntime} (the host owns ONNX / httpvfs / R2 /
 *   the composed map style) plus a {@link GeocoderPanels} bag (the host's ModelVisualizer / VersionCompare /
 *   About / Permalink). Everything here is composition + a `ClientOnly` boundary:
 *
 *     - the floating {@link GeocoderControls} panel (version / compare / backend / query+autocomplete / result),
 *     - the declarative {@link MapCanvas} with the phase-2 overlays ({@link OverlayLayers}) and the
 *       resolved-place marker/outline/camera ({@link ResolvedPlaceLayers}) driven by the parse state,
 *     - the hooks that wire them: {@link useGeocode} (parse + viewport bias + map place),
 *       {@link usePlaceAutocomplete}, {@link useCompareState}.
 *
 *   Because it pulls {@link MapCanvas} (→ `react-map-gl` → `maplibre-gl`, WebGL + DOM at import), it lives on
 *   the `@mailwoman/react/map` subpath ONLY — never the package root. The whole thing renders in Storybook
 *   over a fake runtime (offline stub style + canned geocode) with no network, no ONNX, no gazetteer.
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
import { MapCanvas } from "./MapCanvas.tsx"
import { OverlayLayers } from "./OverlayLayers.tsx"
import { ResolvedPlaceLayers } from "./ResolvedPlaceLayers.tsx"

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
	 * Example chips. @default the empty set (host supplies its own).
	 */
	presets?: ReadonlyArray<Preset>
	/**
	 * Open the developer disclosure on mount — the model version, the backend readout and compare. Collapsed by default
	 * so the address field is the first thing a visitor meets. @default false
	 */
	developer?: boolean
	/**
	 * Only hint the viewport bias once the visitor has zoomed past the global view — a whole-globe center is noise.
	 * Matches the `map.getZoom() >= 4` threshold. @default 4
	 */
	minBiasZoom?: number
	/**
	 * Fly/fit the map to the resolved place on each result (via {@link ResolvedPlaceLayers}). @default true. Set false
	 * for a host that drives the camera itself (a controlled `<MapCanvas viewState>`), or to keep a headless test
	 * deterministic — the marker + outline still render, only the animated camera move is skipped.
	 */
	applyResultCamera?: boolean
}

interface GeocoderInnerProps extends Required<
	Pick<GeocoderProps, "runtime" | "defaultAddress" | "minBiasZoom" | "applyResultCamera" | "developer">
> {
	panels: GeocoderPanels
	presets: ReadonlyArray<Preset>
}

function GeocoderInner({
	runtime,
	panels,
	defaultAddress,
	presets,
	minBiasZoom,
	applyResultCamera,
	developer,
}: GeocoderInnerProps): ReactNode {
	const mapRef = useRef<MapRef>(null)
	// The chrome sits OUTSIDE `<MapCanvas>`, so it cannot take the handle from `useMap()`. A ref alone does not
	// re-render the compass or the layer control when the map arrives, so the same poll that publishes the test
	// handle also puts it in state — one poll, two consumers.
	const [map, setMap] = useState<ReturnType<MapRef["getMap"]> | null>(null)

	// TEST INJECTION POINT: the e2e viewport-bias suite drives the REAL map (pan + zoom past the bias threshold)
	// before submitting, and a browser test cannot reach a React ref — so the live map handle is
	// republished on `globalThis.__mailwomanMapCanvas`. The ref fills only after react-map-gl instantiates
	// the map, hence the short poll; cleared on unmount so a torn-down geocoder never leaves a stale
	// handle behind.
	useEffect(() => {
		const host = globalThis as { __mailwomanMapCanvas?: ReturnType<MapRef["getMap"]> }

		const timer = setInterval(() => {
			const ready = mapRef.current?.getMap()

			if (ready) {
				host.__mailwomanMapCanvas = ready
				setMap(ready)
				clearInterval(timer)
			}
		}, 250)

		return () => {
			clearInterval(timer)
			setMap(null)
			delete host.__mailwomanMapCanvas
		}
	}, [])

	// Read the viewport bias at submit time — through the map handle, never a threaded state value, so granting/zooming
	// mid-session doesn't re-create the parse callback. Below the min-bias zoom, a whole-globe center is noise → null.
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
					// One compact attribution pill (the map's own default is a wide, always-open "MapLibre | © …" bar), no
					// maplibre wordmark logo.
					mapProps={{ attributionControl: { compact: true }, maplibreLogo: false }}
				>
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
				map={map}
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
				/>
			)}
		</ClientOnly>
	)
}
