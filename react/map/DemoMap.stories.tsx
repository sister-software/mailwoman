/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `<DemoMap>` stories against a STUB style — a single `background` layer, zero sources, zero network.
 *   Never hits `tiles.sister.software`; the whole point of the extracted map is that it renders in
 *   isolation (Storybook / a headless browser) with an injected offline style, exactly as the composed
 *   demo will with a fake runtime in a later phase.
 */

import type { Meta, StoryObj } from "@storybook/react-vite"

import { DemoMap, type DemoMapStyle } from "./DemoMap.tsx"

/** An offline style: one solid `background` layer. No glyphs, sprite, sources, or tiles → no network. */
const STUB_STYLE: DemoMapStyle = {
	version: 8,
	name: "demo-map-stub",
	sources: {},
	layers: [{ id: "background", type: "background", paint: { "background-color": "#dfe7ee" } }],
}

const meta: Meta<typeof DemoMap> = {
	title: "Map/DemoMap",
	component: DemoMap,
	parameters: { layout: "fullscreen" },
	args: {
		mapStyle: STUB_STYLE,
		initialViewState: { longitude: -74.006, latitude: 40.7128, zoom: 10 },
		style: { width: "100%", height: "480px" },
	},
}

export default meta
type Story = StoryObj<typeof DemoMap>

/** The bare shell over the stub style. */
export const StubStyle: Story = {}

/** A child slot demo — later phases fill this with `<Source>`/`<Layer>`/`<Marker>` overlays. */
export const WithChildrenSlot: Story = {
	args: {
		children: (
			<div
				style={{
					position: "absolute",
					top: 12,
					left: 12,
					padding: "6px 10px",
					borderRadius: 6,
					background: "rgba(255,255,255,0.85)",
					font: "13px system-ui, sans-serif",
				}}
			>
				overlays mount here (phase 2)
			</div>
		),
	},
}
