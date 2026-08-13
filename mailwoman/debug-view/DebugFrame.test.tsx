/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { DebugFrame } from "./DebugFrame.tsx"
import { renderInkToString } from "./static-render.ts"

const TREE = {
	raw: "3215 SE Clinton St, Portland OR",
	roots: [
		{ tag: "house_number", value: "3215", start: 0, end: 4, confidence: 0.99, children: [] },
		{ tag: "street", value: "SE Clinton St", start: 5, end: 18, confidence: 0.98, children: [] },
		{ tag: "locality", value: "Portland", start: 20, end: 28, confidence: 0.97, children: [] },
		{ tag: "region", value: "OR", start: 29, end: 31, confidence: 0.96, children: [] },
	],
} as never

const RESULT = {
	input: "3215 SE Clinton St, Portland OR",
	lat: 45.5034,
	lon: -122.6023,
	resolution_tier: "address_point",
	uncertainty_m: 8,
	locality: "Portland",
	region: "Oregon",
	postcode: null,
	house_number: "3215",
	street: "SE Clinton St",
	hierarchy: [{ tag: "locality", value: "Portland", placeID: "wof:101715829", lat: 45.52, lon: -122.67 }],
	candidates: [],
	components: {},
	venue: null,
	dependent_locality: null,
} as never

describe("DebugFrame", () => {
	it("renders all three panes with the parse and the resolution", async () => {
		const text = await renderInkToString(
			<DebugFrame
				columns={100}
				rows={30}
				focused={null}
				color={true}
				data={{
					input: RESULT.input,
					tree: TREE,
					result: RESULT,
					frame: null,
					mapNote: "no tiles: set $MAILWOMAN_TILES or --tiles",
				}}
			/>,
			100
		)

		expect(text).toContain("3215 SE Clinton St")
		expect(text).toContain("address_point")
		expect(text).toContain("45.5034")
		expect(text).toContain("no tiles")
	})

	it("marks the focused pane", async () => {
		const focusedText = await renderInkToString(
			<DebugFrame
				columns={100}
				rows={30}
				focused="map"
				color={true}
				data={{ input: RESULT.input, tree: TREE, result: RESULT, frame: null, mapNote: null }}
			/>,
			100
		)

		expect(focusedText).toContain("map") // focused pane title is highlighted + suffixed, e.g. "map ◀"
	})
})
