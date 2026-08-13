/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { AddressTree } from "@mailwoman/core/decoder"
import { describe, expect, it } from "vitest"

import type { GeocodeResult } from "../geocode-core.ts"
import { DebugFrame, mapPaneCellSize, ribbonSegments } from "./DebugFrame.tsx"
import { renderInkToString } from "./static-render.ts"

const TREE = {
	raw: "3215 SE Clinton St, Portland OR",
	roots: [
		{ tag: "house_number", value: "3215", start: 0, end: 4, confidence: 0.99, children: [] },
		{ tag: "street", value: "SE Clinton St", start: 5, end: 18, confidence: 0.98, children: [] },
		{ tag: "locality", value: "Portland", start: 20, end: 28, confidence: 0.97, children: [] },
		{ tag: "region", value: "OR", start: 29, end: 31, confidence: 0.96, children: [] },
	],
} as unknown as AddressTree

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
} as unknown as GeocodeResult

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

	it("the ribbon losslessly reconstructs the input, connector text included", () => {
		const segments = ribbonSegments(TREE)

		// #493 round trip: concatenating every segment's value reproduces the raw input exactly — the
		// ", " between the street and the locality must survive as an `unknown` segment, not vanish.
		expect(segments.map((segment) => segment.value).join("")).toBe(TREE.raw)
		expect(segments.some((segment) => segment.tag === undefined && segment.value.includes(","))).toBe(true)
	})

	it("sizes a map frame from mapPaneCellSize so MapPane renders it without dropping any chrome", async () => {
		const columns = 100
		const rows = 30
		const cellSize = mapPaneCellSize(columns, rows)
		const cellCount = cellSize.columns * cellSize.rows
		// Every cell inked with a distinctive marker char, so a dropped frame row is visible directly
		// (a naive total-line-count check can't tell "rendered" from "silently clipped" — Ink doesn't
		// grow a Box past its declared `height` when children overflow it; it drops rows to fit, which
		// keeps the outer line count unchanged and would pass a line-count-only assertion).
		const MARKER_CODEPOINT = "#".codePointAt(0)!

		const frame = {
			columns: cellSize.columns,
			rows: cellSize.rows,
			chars: new Uint32Array(cellCount).fill(MARKER_CODEPOINT),
			colors: new Uint32Array(cellCount),
			attribution: "test attribution",
		}

		const text = await renderInkToString(
			<DebugFrame
				columns={columns}
				rows={rows}
				focused={null}
				color={true}
				data={{ input: RESULT.input, tree: TREE, result: RESULT, frame, mapNote: null }}
			/>,
			columns
		)

		// Ink's raw write ends with a trailing "\n" (an empty final split element, not an extra row). The
		// string being split is one already-rendered terminal frame — small, bounded, and never re-split
		// or grown — so a spliterator buys nothing here.
		// oxlint-disable-next-line mailwoman/prefer-spliterator -- one small fixed-size rendered frame, not a stream
		const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n")
		const markedLineCount = lines.filter((line) => line.includes("#")).length

		// Every requested frame row actually rendered — an undercounted chrome budget clips rows (and/or
		// the title) to fit MapPane's declared box height instead of growing past it.
		expect(markedLineCount).toBe(cellSize.rows)
		expect(text).toContain("map")
		expect(text).toContain("test attribution")
		expect(lines).toHaveLength(rows)
	})
})
