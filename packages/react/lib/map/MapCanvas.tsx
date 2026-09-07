/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `<MapCanvas>` — the declarative map shell for the geocoder demo, over `react-map-gl/maplibre` (v8).
 *   Phase 1 is the shell only: a `<Map>` that takes a host-composed `mapStyle`, an initial (or
 *   controlled) view state, and a `children` slot for the overlays/markers that land in later phases.
 *   No overlay/marker/camera logic lives here yet.
 *
 *   NODE-IMPORT SAFETY: this module imports `react-map-gl/maplibre` (which pulls `maplibre-gl` — WebGL
 *   + DOM at import) at module scope, so it is reachable ONLY through the `@mailwoman/react/map`
 *   subpath, never from the package root (`index.ts`). The bare `import("@mailwoman/react")` a node
 *   consumer (or the CI smoke IMPORT_CHECK) runs must never transitively load this file. Keep it out of
 *   the root barrel.
 *
 *   CSS: the package imports no CSS from its modules (the node-safe invariant), so a host that renders
 *   `<MapCanvas>` must import `maplibre-gl/dist/maplibre-gl.css` itself (plus `@mailwoman/react/styles.css`
 *   for the `.mw-demo-map` container). `<MapCanvas>` is intrinsically a client component — a host that
 *   server-renders should wrap it in a client boundary (the package's `ClientOnly`), exactly as the
 *   composed `Geocoder` will in a later phase.
 */

import type { CSSProperties, ReactNode, Ref } from "react"
import { Map } from "react-map-gl/maplibre"
import type { MapProps, MapRef, ViewStateChangeEvent } from "react-map-gl/maplibre"

/**
 * The style a `<MapCanvas>` renders — a style URL or an inline/composed `StyleSpecification`.
 */
export type MapCanvasStyle = NonNullable<MapProps["mapStyle"]>

/**
 * Override for the `<Map>` props `<MapCanvas>` does not surface explicitly (e.g. `minZoom`, `attributionControl`,
 * `maplibreLogo`). The controlled fields MapCanvas owns are omitted so they can't be set twice.
 */
export type MapCanvasExtraProps = Partial<
	Omit<MapProps, "mapStyle" | "initialViewState" | "viewState" | "onMove" | "children" | "style" | "ref">
>

export interface MapCanvasProps {
	/**
	 * The map style — host-composed `StyleSpecification` or a style URL.
	 */
	mapStyle: MapCanvasStyle
	/**
	 * Uncontrolled initial camera. Use this OR `viewState`, not both.
	 */
	initialViewState?: MapProps["initialViewState"]
	/**
	 * Controlled camera. Pair with `onMove` to persist it.
	 */
	viewState?: MapProps["viewState"]
	/**
	 * Fired on every camera change (drag/zoom/rotate) — the hook for viewport-bias persistence.
	 */
	onMove?: (event: ViewStateChangeEvent) => void
	/**
	 * Map projection. @default "globe" (matches the docs `DashboardMap`).
	 */
	projection?: MapProps["projection"]
	/**
	 * Forwarded to the underlying `<Map>` for imperative access (`useMap`/`flyTo` in later phases).
	 */
	mapRef?: Ref<MapRef>
	/**
	 * Overlays, markers, and controls — rendered as `<Map>` children. Empty in phase 1.
	 */
	children?: ReactNode
	/**
	 * Class on the wrapper element.
	 */
	className?: string
	/**
	 * Inline style on the wrapper element (sizing lives here or on `.mw-demo-map`).
	 */
	style?: CSSProperties
	/**
	 * Remaining `<Map>` props MapCanvas does not surface explicitly.
	 */
	mapProps?: MapCanvasExtraProps
}

const FILL: CSSProperties = { width: "100%", height: "100%" }

/**
 * The controlled-viewport map shell. Renders a sized wrapper around a `react-map-gl/maplibre` `<Map>`; everything
 * host-specific (the composed `mapStyle`, the initial center) is injected, and overlays ride in as `children`.
 */
export function MapCanvas({
	mapStyle,
	initialViewState,
	viewState,
	onMove,
	projection = "globe",
	mapRef,
	children,
	className,
	style,
	mapProps,
}: MapCanvasProps): ReactNode {
	const wrapperClassName = className ? `mw-demo-map ${className}` : "mw-demo-map"

	return (
		<div className={wrapperClassName} style={style}>
			<Map
				{...mapProps}
				ref={mapRef}
				mapStyle={mapStyle}
				initialViewState={initialViewState}
				viewState={viewState}
				onMove={onMove}
				projection={projection}
				style={FILL}
			>
				{children}
			</Map>
		</div>
	)
}
