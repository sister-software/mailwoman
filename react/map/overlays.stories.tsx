/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Stories for the declarative resolved-place overlays, over the SAME offline stub style as `DemoMap`
 *   (one `background` layer, zero network — never hits `tiles.sister.software`). Each story feeds a fake
 *   resolved place through `computeMapPlaceRenderSpec` and drops `<ResolvedPlaceLayers>` into `<DemoMap>`,
 *   covering every branch of the render cascade: bbox circle, crisp polygon, street-radius circle,
 *   anchor-centroid postcode, and the bare point — plus a host `<OverlayLayers>` overlay.
 */

import type { Meta, StoryObj } from "@storybook/react-vite"
import type { ReactNode } from "react"

import { DemoMap, type DemoMapStyle } from "./DemoMap.tsx"
import { OverlayLayers } from "./OverlayLayers.tsx"
import { computeMapPlaceRenderSpec, type ResolvedMapPlace } from "./place-render.ts"
import { ResolvedPlaceLayers } from "./ResolvedPlaceLayers.tsx"
import type { OverlaySpec } from "./types.ts"

const STUB_STYLE: DemoMapStyle = {
	version: 8,
	name: "overlays-stub",
	sources: {},
	layers: [{ id: "background", type: "background", paint: { "background-color": "#dfe7ee" } }],
}

/** Base place; each story overrides only the fields its branch needs. */
function place(overrides: Partial<ResolvedMapPlace>): ResolvedMapPlace {
	return { id: 1, name: "Demo Place", placetype: "locality", lat: 40.7128, lon: -74.006, score: 1, ...overrides }
}

interface SceneProps {
	/** The resolved place to render. */
	place: ResolvedMapPlace
	/** Optional host overlays to layer beneath the resolved place. */
	overlays?: OverlaySpec[]
	/** Apply the computed camera (fly/fit). @default false in stories so the fixed initial view stays put. */
	applyCamera?: boolean
}

/** A self-contained scene: compute the spec, render the map + overlays. */
function OverlayScene({ place: resolved, overlays, applyCamera = false }: SceneProps): ReactNode {
	const spec = computeMapPlaceRenderSpec(resolved)

	return (
		<DemoMap
			mapStyle={STUB_STYLE}
			initialViewState={{ longitude: resolved.lon, latitude: resolved.lat, zoom: 9 }}
			style={{ width: "100%", height: "480px" }}
		>
			<OverlayLayers overlays={overlays} />
			<ResolvedPlaceLayers spec={spec} applyCamera={applyCamera} />
		</DemoMap>
	)
}

const meta: Meta<typeof OverlayScene> = {
	title: "Map/Overlays",
	component: OverlayScene,
	parameters: { layout: "fullscreen" },
}

export default meta
type Story = StoryObj<typeof OverlayScene>

/** An admin place with a bbox → marker + a bbox-sized approximate circle. */
export const BboxCircle: Story = {
	args: { place: place({ bbox: { minLat: 40.6, maxLat: 40.85, minLon: -74.1, maxLon: -73.85 } }) },
}

/** A pre-fetched crisp admin polygon → marker + the real boundary drawn. */
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

/** A street-level (exact building) hit → marker + a tight uncertainty circle. */
export const StreetRadius: Story = {
	args: { place: place({ tier: "address_point", uncertaintyM: 10 }) },
}

/** An anchor-centroid postcode (no bbox) → marker + a ~3 km "around here" circle. */
export const PostcodeCircle: Story = {
	args: { place: place({ placetype: "postcode" }) },
}

/** A bare point (no bbox, no tier, no polygon) → marker only, no outline. */
export const BarePoint: Story = {
	args: { place: place({}) },
}

/** The bbox circle layered over a host overlay (a translucent coverage rectangle). */
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
