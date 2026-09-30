/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { ReactNode } from "react"

import type { MapPlaceRenderSpec } from "#map/place-render"

import { PlaceMarker } from "./PlaceMarker.tsx"
import { ResultCamera } from "./ResultCamera.tsx"
import { ResultOverlay } from "./ResultOverlay.tsx"

export interface ResolvedPlaceLayersProps {
	/**
	 * The render spec (from {@link useMapPlaceRender}); `null` renders no layers.
	 */
	spec: MapPlaceRenderSpec | null
	/**
	 * Apply the computed camera target via {@link ResultCamera}; set false when the consumer drives the camera
	 * itself (e.g. a controlled `<MapCanvas viewState>` fed by {@link cameraToViewState}). @default true
	 */
	applyCamera?: boolean
	/**
	 * Animate the camera move, forwarded to {@link ResultCamera}. @default true
	 */
	animateCamera?: boolean
	/**
	 * Source/layer id prefix for the outline. @default "mw-result"
	 */
	outlineID?: string
	/**
	 * Marker color. @default the house pink.
	 */
	markerColor?: string
}

/**
 * Render the marker(s), outline and optional camera move for one resolved place.
 */
export function ResolvedPlaceLayers({
	spec,
	applyCamera = true,
	animateCamera = true,
	outlineID,
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
			<ResultOverlay outline={spec.outline} id={outlineID} color={markerColor} />
			{applyCamera ? <ResultCamera target={spec.camera} animate={animateCamera} /> : null}
		</>
	)
}
