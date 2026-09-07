/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   THE MILESTONE STORY: the WHOLE `<Geocoder>` runs here end-to-end over a FAKE runtime —
 *   offline stub map style (one background layer, no tiles), a canned geocode (no ONNX, no gazetteer), a
 *   synchronous autocomplete, a fake version list + backend. Open Storybook, type a query, hit
 *   "Parse + resolve", and the geocoder responds: the result panel fills in and the map drops a marker +
 *   outline and flies to it — with ZERO network. `FullGeocoder` is the bare composition; `WithPanels` slots in
 *   host panels (about / release / compare / debug drawer / permalink) to exercise the injection point.
 */

import type { Meta, StoryObj } from "@storybook/react-vite"
import { useMemo, useState } from "react"

import { makeFakeGeocoderRuntime } from "#map/fake-runtime"
import type { GeocoderPanels } from "#map/types"

import { Geocoder } from "./Geocoder.tsx"

const PRESETS = [
	{ label: "White House", value: "1600 Pennsylvania Ave NW, Washington, DC 20500" },
	{ label: "Empire State", value: "350 5th Ave, New York, NY 10118" },
	{ label: "ZIP only", value: "90210" },
]

/**
 * A stateful wrapper so the version picker + WASM toggle actually drive (a plain fixture can't hold state).
 */
function StatefulGeocoder({ panels }: { panels?: GeocoderPanels }) {
	const [selectedVersion, setSelectedVersion] = useState("v7.2.0")
	const [forceWASM, setForceWASM] = useState(false)

	const runtime = useMemo(
		() =>
			makeFakeGeocoderRuntime({
				selectedVersion,
				selectVersion: setSelectedVersion,
				forceWASM,
				setForceWASM,
				activeBackend: forceWASM ? "wasm (28 MB int8)" : "webgpu (28 MB int8)",
			}),
		[selectedVersion, forceWASM]
	)

	return (
		<Geocoder runtime={runtime} panels={panels} defaultAddress="350 5th Ave, New York, NY 10118" presets={PRESETS} />
	)
}

const meta: Meta<typeof StatefulGeocoder> = {
	title: "Map/Geocoder",
	component: StatefulGeocoder,
	parameters: { layout: "fullscreen" },
	decorators: [
		(Story) => (
			<div style={{ position: "relative", width: "100%", height: "600px" }}>
				<Story />
			</div>
		),
	],
}

export default meta

type Story = StoryObj<typeof StatefulGeocoder>

/**
 * The whole geocoder over the fake runtime — type an address, parse, watch the map + panel respond.
 */
export const FullGeocoder: Story = {}

/**
 * The same geocoder with host-injected panels wired into the DI bag (about / release / compare / debug / permalink).
 */
export const WithPanels: Story = {
	args: {
		panels: {
			header: <p style={{ margin: "0 0 0.75rem", fontWeight: 600 }}>Mailwoman geocoder — fake runtime</p>,
			releaseInfo: (
				<p style={{ margin: "0 0 0.75rem", fontSize: "0.85rem", opacity: 0.7 }}>
					<strong>v7.2.0</strong> — the composed geocoder, mocked end-to-end.
				</p>
			),
			extras: (result) => (
				<details style={{ margin: "0.5rem 0" }}>
					<summary>Raw nodes ({result.nodes.length})</summary>
					<pre style={{ fontSize: 12 }}>{JSON.stringify(result.nodes, null, 2)}</pre>
				</details>
			),
			compare: ({ compareMode, compareVersion }) =>
				compareMode ? (
					<p style={{ marginTop: "0.75rem", fontSize: "0.85rem" }}>
						Compare drawer would render here (vs <code>{compareVersion ?? "—"}</code>).
					</p>
				) : null,
			permalink: (text) => (
				<span style={{ fontSize: "0.8rem", opacity: 0.6 }} title={text}>
					🔗 permalink
				</span>
			),
			debugDrawer: () => null,
		},
	},
}
