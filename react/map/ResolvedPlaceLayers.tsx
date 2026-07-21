/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `<ResolvedPlaceLayers>` — the drop-in that renders a whole {@link MapPlaceRenderSpec} as `<DemoMap>`
 *   children: the marker(s), the outline, and (optionally) the camera move. This is the declarative
 *   replacement for the demo's imperative marker/bbox/camera redraw effect — a consumer computes the spec
 *   with `useMapPlaceRender(place)` and drops `<ResolvedPlaceLayers spec={spec} />` inside `<DemoMap>`.
 *
 *   `spec = null` (no result / no candidate) renders nothing, which also unmounts the previous marker +
 *   outline — the teardown the old effect did by hand (`markerRef.remove()`, `clearBbox`) is now just
 *   React unmounting. NODE-IMPORT SAFETY: pulls the map components — `@mailwoman/react/map` only.
 */

import type { ReactNode } from "react"

import type { MapPlaceRenderSpec } from "./place-render.ts"
import { PlaceMarker } from "./PlaceMarker.tsx"
import { ResultCamera } from "./ResultCamera.tsx"
import { ResultOverlay } from "./ResultOverlay.tsx"

export interface ResolvedPlaceLayersProps {
	/** The render spec (from {@link useMapPlaceRender}); `null` renders nothing. */
	spec: MapPlaceRenderSpec | null
	/**
	 * Apply the computed camera target via {@link ResultCamera}. @default true. Set false when the consumer drives the
	 * camera itself (e.g. a controlled `<DemoMap viewState>` fed by {@link cameraToViewState}).
	 */
	applyCamera?: boolean
	/** Animate the camera move. Forwarded to {@link ResultCamera}. @default true */
	animateCamera?: boolean
	/** Source/layer id prefix for the outline. @default "mw-result" */
	outlineId?: string
	/** Marker color. @default the house pink. */
	markerColor?: string
}

/** Render the marker(s), outline, and (optional) camera move for one resolved place. */
export function ResolvedPlaceLayers({
	spec,
	applyCamera = true,
	animateCamera = true,
	outlineId,
	markerColor,
}: ResolvedPlaceLayersProps): ReactNode {
	if (!spec) return null

	return (
		<>
			{spec.markers.map(([longitude, latitude], index) => (
				<PlaceMarker
					key={`${longitude},${latitude},${index}`}
					longitude={longitude}
					latitude={latitude}
					color={markerColor}
				/>
			))}
			<ResultOverlay outline={spec.outline} id={outlineId} color={markerColor} />
			{applyCamera ? <ResultCamera target={spec.camera} animate={animateCamera} /> : null}
		</>
	)
}
