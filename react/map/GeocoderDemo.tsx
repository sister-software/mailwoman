/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `<GeocoderDemo>` — the WHOLE geocoder demo, composed. It is the map analogue of `PipelineExplorer`
 *   and takes the SAME DI seam shape: an injected {@link DemoRuntime} (the host owns ONNX / httpvfs / R2 /
 *   the composed map style) plus a {@link DemoPanels} bag (the host's ModelVisualizer / VersionCompare /
 *   About / Permalink). Everything here is composition + a `ClientOnly` boundary:
 *
 *     - the floating {@link DemoControls} panel (version / compare / backend / query+autocomplete / result),
 *     - the declarative {@link DemoMap} with the phase-2 overlays ({@link OverlayLayers}) and the
 *       resolved-place marker/outline/camera ({@link ResolvedPlaceLayers}) driven by the parse state,
 *     - the hooks that wire them: {@link useDemoGeocode} (parse + viewport bias + map place),
 *       {@link usePlaceAutocomplete}, {@link useCompareState}.
 *
 *   Because it pulls {@link DemoMap} (→ `react-map-gl` → `maplibre-gl`, WebGL + DOM at import), it lives on
 *   the `@mailwoman/react/map` subpath ONLY — never the package root. The whole thing renders in Storybook
 *   over a fake runtime (offline stub style + canned geocode) with no network, no ONNX, no gazetteer.
 */

import { type ReactNode, useCallback, useRef } from "react"
import type { MapRef } from "react-map-gl/maplibre"

import { ClientOnly } from "../common/ClientOnly.tsx"
import { type Preset } from "../common/PresetChips.tsx"
import { DemoControls } from "./DemoControls.tsx"
import { DemoMap } from "./DemoMap.tsx"
import { OverlayLayers } from "./OverlayLayers.tsx"
import { ResolvedPlaceLayers } from "./ResolvedPlaceLayers.tsx"
import type { DemoPanels, DemoRuntime, MapBias } from "./types.ts"
import { useCompareState } from "./useCompareState.ts"
import { useDemoGeocode } from "./useDemoGeocode.ts"
import { useMapPlaceRender } from "./useMapPlaceRender.ts"
import { usePlaceAutocomplete } from "./usePlaceAutocomplete.ts"

export interface GeocoderDemoProps {
	/** The injected demo runtime (map style + overlays + parse + version/backend). */
	runtime: DemoRuntime
	/** Host-injected panels (about, release blurb, compare, permalink, debug drawer, map controls, …). */
	panels?: DemoPanels
	/** Address to pre-fill. */
	defaultAddress?: string
	/** Example chips. @default the empty set (host supplies its own). */
	presets?: ReadonlyArray<Preset>
	/**
	 * Only hint the viewport bias once the visitor has zoomed past the global view — a whole-globe center is noise.
	 * Matches the demo's `map.getZoom() >= 4` gate. @default 4
	 */
	minBiasZoom?: number
	/**
	 * Fly/fit the map to the resolved place on each result (via {@link ResolvedPlaceLayers}). @default true. Set false
	 * for a host that drives the camera itself (a controlled `<DemoMap viewState>`), or to keep a headless test
	 * deterministic — the marker + outline still render, only the animated camera move is skipped.
	 */
	applyResultCamera?: boolean
}

interface GeocoderDemoInnerProps extends Required<
	Pick<GeocoderDemoProps, "runtime" | "defaultAddress" | "minBiasZoom" | "applyResultCamera">
> {
	panels: DemoPanels
	presets: ReadonlyArray<Preset>
}

function GeocoderDemoInner({
	runtime,
	panels,
	defaultAddress,
	presets,
	minBiasZoom,
	applyResultCamera,
}: GeocoderDemoInnerProps): ReactNode {
	const mapRef = useRef<MapRef>(null)

	// Read the viewport bias at submit time — through the map handle, never a threaded state value, so granting/zooming
	// mid-session doesn't re-create the parse callback. Below the min-bias zoom, a whole-globe center is noise → null.
	const getBias = useCallback((): MapBias | null => {
		const map = mapRef.current?.getMap()

		if (!map) return null
		const zoom = map.getZoom()

		if (zoom < minBiasZoom) return null
		const center = map.getCenter()

		return { center: [center.lng, center.lat], zoom }
	}, [minBiasZoom])

	const geocode = useDemoGeocode({ runtime, defaultText: defaultAddress, getBias })
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
				<DemoMap
					mapStyle={runtime.mapStyle}
					mapRef={mapRef}
					initialViewState={{
						longitude: runtime.initialCenter[0],
						latitude: runtime.initialCenter[1],
						zoom: runtime.initialZoom ?? 3,
					}}
					style={{ width: "100%", height: "100%" }}
				>
					<OverlayLayers overlays={runtime.overlays} />
					<ResolvedPlaceLayers spec={spec} applyCamera={applyResultCamera} />
					{panels.mapControls}
				</DemoMap>
			</div>

			<DemoControls
				runtime={runtime}
				geocode={geocode}
				autocomplete={autocomplete}
				compare={compare}
				panels={panels}
				presets={presets}
				placeholder={defaultAddress}
				onSelectVersion={onSelectVersion}
				onForceWASMChange={onForceWASMChange}
			/>

			{panels.debugDrawer}
		</div>
	)
}

/** The composed geocoder demo, behind a `ClientOnly` SSR boundary (the map is intrinsically a client component). */
export function GeocoderDemo({
	runtime,
	panels = {},
	defaultAddress = "",
	presets = [],
	minBiasZoom = 4,
	applyResultCamera = true,
}: GeocoderDemoProps): ReactNode {
	return (
		<ClientOnly
			fallback={
				<div className="mw-geocoder-demo">
					<p>Loading demo…</p>
				</div>
			}
		>
			{() => (
				<GeocoderDemoInner
					runtime={runtime}
					panels={panels}
					defaultAddress={defaultAddress}
					presets={presets}
					minBiasZoom={minBiasZoom}
					applyResultCamera={applyResultCamera}
				/>
			)}
		</ClientOnly>
	)
}
