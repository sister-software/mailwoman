/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { Meta, StoryObj } from "@storybook/react-vite"
import type { ReactNode } from "react"

import { computeMapPlaceRenderSpec, type ResolvedMapPlace } from "#map/place-render"
import type { OverlaySpec } from "#map/types"

import { MapCanvas, type MapCanvasStyle } from "./MapCanvas.tsx"
import { OverlayLayers } from "./OverlayLayers.tsx"
import { ResolvedPlaceLayers } from "./ResolvedPlaceLayers.tsx"

// The stub style has a single background layer, so the stories make no network requests.
const STUB_STYLE: MapCanvasStyle = {
	version: 8,
	name: "overlays-stub",
	sources: {},
	layers: [{ id: "background", type: "background", paint: { "background-color": "#dfe7ee" } }],
}

function place(overrides: Partial<ResolvedMapPlace>): ResolvedMapPlace {
	return { id: 1, name: "Demo Place", placetype: "locality", lat: 40.7128, lon: -74.006, score: 1, ...overrides }
}

interface SceneProps {
	/**
	 * The resolved place to render.
	 */
	place: ResolvedMapPlace
	/**
	 * Host overlays drawn beneath the resolved place.
	 */
	overlays?: OverlaySpec[]
	/**
	 * Whether to move the camera to the place.
	 *
	 * @default false
	 */
	applyCamera?: boolean
}

function OverlayScene({ place: resolved, overlays, applyCamera = false }: SceneProps): ReactNode {
	const spec = computeMapPlaceRenderSpec(resolved)

	return (
		<MapCanvas
			mapStyle={STUB_STYLE}
			initialViewState={{ longitude: resolved.lon, latitude: resolved.lat, zoom: 9 }}
			style={{ width: "100%", height: "480px" }}
		>
			<OverlayLayers overlays={overlays} />
			<ResolvedPlaceLayers spec={spec} applyCamera={applyCamera} />
		</MapCanvas>
	)
}

/**
 * Stories for the resolved-place overlays, one for each branch of `computeMapPlaceRenderSpec`.
 */
const meta: Meta<typeof OverlayScene> = {
	title: "Map/Overlays",
	component: OverlayScene,
	parameters: { layout: "fullscreen" },
}

export default meta

type Story = StoryObj<typeof OverlayScene>

/**
 * A place with a bounding box renders a marker and a circle sized to the box.
 */
export const BboxCircle: Story = {
	args: { place: place({ bbox: { minLat: 40.6, maxLat: 40.85, minLon: -74.1, maxLon: -73.85 } }) },
}

/**
 * A place with a polygon geometry renders a marker and that boundary.
 */
export const CrispPolygon: Story = {
	args: {
		place: place({
			geometry: {
				type: "Polygon",
				coordinates: [
					[
						[-74.05, 40.66],
						[-73.94, 40.66],
						[-73.92, 40.74],
						[-73.99, 40.8],
						[-74.06, 40.74],
						[-74.05, 40.66],
					],
				],
			},
		}),
	},
}

/**
 * A place with a tier and an uncertainty radius renders a marker and a circle of that radius.
 */
export const StreetRadius: Story = {
	args: { place: place({ tier: "address_point", uncertaintyM: 10 }) },
}

/**
 * A postcode without a bounding box renders a marker and a default-radius circle.
 */
export const PostcodeCircle: Story = {
	args: { place: place({ placetype: "postcode" }) },
}

/**
 * A place without a bounding box, tier, or polygon renders only a marker.
 */
export const BarePoint: Story = {
	args: { place: place({}) },
}

/**
 * The bounding-box circle drawn over a translucent coverage rectangle supplied as a host overlay.
 */
export const WithHostOverlay: Story = {
	args: {
		place: place({ bbox: { minLat: 40.6, maxLat: 40.85, minLon: -74.1, maxLon: -73.85 } }),
		overlays: [
			{
				id: "coverage",
				source: {
					type: "geojson",
					data: {
						type: "FeatureCollection",
						features: [
							{
								type: "Feature",
								properties: {},
								geometry: {
									type: "Polygon",
									coordinates: [
										[
											[-74.3, 40.5],
											[-73.7, 40.5],
											[-73.7, 40.95],
											[-74.3, 40.95],
											[-74.3, 40.5],
										],
									],
								},
							},
						],
					},
				},
				layers: [
					{
						id: "coverage-fill",
						type: "fill",
						source: "coverage",
						paint: { "fill-color": "#3aa0ff", "fill-opacity": 0.15 },
					},
				],
				label: "Coverage",
			},
		],
	},
}
