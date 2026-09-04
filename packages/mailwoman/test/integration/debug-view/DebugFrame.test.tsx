/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { AddressTree } from "@mailwoman/core/decoder"
import { DebugFrame, mapPaneCellSize, outputPaneCapacity, ribbonSegments } from "mailwoman/debug-view/DebugFrame"
import { renderInkToString } from "mailwoman/debug-view/static-render"
import type { GeocodeResult, GeocodeTrace } from "mailwoman/geocode"
import { describe, expect, it } from "vitest"

const TREE = {
	raw: "3215 SE Clinton St, Portland OR",
	roots: [
		{ tag: "house_number", value: "3215", start: 0, end: 4, confidence: 0.99, children: [] },
		{ tag: "street", value: "SE Clinton St", start: 5, end: 18, confidence: 0.98, children: [] },
		{ tag: "locality", value: "Portland", start: 20, end: 28, confidence: 0.97, children: [] },
		{ tag: "region", value: "OR", start: 29, end: 31, confidence: 0.96, children: [] },
	],
} as AddressTree

const RESULT = {
	input: "3215 SE Clinton St, Portland OR",
	lat: 45.5034,
	lon: -122.6023,
	resolution_tier: "address_point",
	epistemic_status: "observed",
	uncertainty_m: 8,
	locality: "Portland",
	region: "Oregon",
	postcode: null,
	house_number: "3215",
	street: "SE Clinton St",
	countryCode: "US",
	hierarchy: [
		{ tag: "locality", value: "Portland", name: "Portland", placeID: "wof:101715829", lat: 45.52, lon: -122.67 },
	],
	candidates: [
		{ name: "Portland", tag: "locality", lat: 45.52, lon: -122.67, countryCode: "US", placeID: "wof:101715829" },
		{ name: "Portland", tag: "locality", lat: 43.66, lon: -70.25, countryCode: "US", placeID: "wof:101715745" },
	],
	components: {},
	venue: null,
	dependent_locality: null,
	unit: null,
	postcode_country_scope: null,
	intent_markers: [],
} as GeocodeResult

/**
 * A trace shaped like the session's, with each evidence row given something distinguishable to say.
 */
const TRACE = {
	parse: {
		text: RESULT.input,
		caseNormalized: false,
		pieces: [
			{ piece: "▁3215", id: 1, start: 0, end: 4 },
			{ piece: "▁Portland", id: 2, start: 20, end: 28 },
		],
		logits: [],
		emissions: [],
		labels: [],
		path: [],
		decode: "viterbi",
		detectedSystem: "us",
		systemSource: "auto",
		localeLogits: [4, 1],
		localeCountries: ["US", "FR"],
		gazetteer: { features: [[], []], confidence: [0, 1] },
		priors: [{ kind: "fst", applied: true }],
		repairs: [],
		tokens: [
			{ piece: "▁3215", start: 0, end: 4, label: "B-house_number", confidence: 0.91 },
			{ piece: "▁Portland", start: 20, end: 28, label: "B-locality", confidence: 0.94 },
		],
	},
	queryShape: {
		characterClass: "alphanumeric",
		tokenClasses: [],
		segments: [],
		knownFormats: [],
		regionAbbreviations: [],
		totalLength: RESULT.input.length,
		whitespacePattern: "single",
	},
	kind: { kind: "structured_address", confidence: 0.9, alternatives: [] },
	inputMode: "formatted",
	locale: "en-US",
	resolver: [],
} as GeocodeTrace

const BASE_DATA = {
	input: RESULT.input,
	tree: TREE,
	result: RESULT,
	frame: null,
	mapNote: "no tiles: set $MAILWOMAN_TILES or --tiles",
}

/**
 * Ink's raw write ends with a trailing "\n" (an empty final split element, not an extra row). The string being split is
 * one already-rendered terminal frame — small, bounded, and never re-split or grown — so a spliterator buys nothing.
 */
function frameLines(text: string): string[] {
	// oxlint-disable-next-line mailwoman/prefer-spliterator -- one small fixed-size rendered frame, not a stream
	return text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n")
}

describe("DebugFrame", () => {
	it("renders all three panes with the parse and the resolution", async () => {
		const text = await renderInkToString(
			<DebugFrame columns={100} rows={30} focused={null} color={true} data={BASE_DATA} />,
			100
		)

		expect(text).toContain("3215 SE Clinton St")
		expect(text).toContain("address_point")
		expect(text).toContain("45.5034")
		expect(text).toContain("no tiles")
	})

	it("marks the focused pane", async () => {
		const focusedText = await renderInkToString(
			<DebugFrame columns={100} rows={30} focused="map" color={true} data={{ ...BASE_DATA, mapNote: null }} />,
			100
		)

		expect(focusedText).toContain("map") // focused pane title is highlighted + suffixed, e.g. "map ◀"
	})

	it("the ribbon losslessly reconstructs the input, connector text included", () => {
		const segments = ribbonSegments(TREE)

		// #493 round trip: concatenating every segment's value reproduces the raw input exactly — the ", " between
		// the street and the locality must survive as an `unknown` segment, not vanish.
		expect(segments.map((segment) => segment.value).join("")).toBe(TREE.raw)
		expect(segments.some((segment) => segment.tag == null && segment.value.includes(","))).toBe(true)
	})

	it("carries the dev-mode evidence rows in the input area", async () => {
		const text = await renderInkToString(
			<DebugFrame columns={140} rows={30} focused={null} color={false} data={{ ...BASE_DATA, trace: TRACE }} />,
			140
		)

		// Each row's LABEL, so the frame is asserted to have a place for the datum...
		for (const label of ["system", "locale-head", "tokens", "channels", "decode"]) {
			expect(text).toContain(label)
		}

		// ...and each row's VALUE, so a label with nothing behind it fails.
		expect(text).toContain("us (auto)")
		expect(text).toContain("mode formatted")
		expect(text).toContain("US 0.95")
		expect(text).toContain("▁3215 ▁Portland")
		expect(text).toContain("gazetteer 1/2")
		expect(text).toContain("priors fst")
	})

	it("reports absent evidence as absent when the session recorded no trace", async () => {
		const text = await renderInkToString(
			<DebugFrame columns={140} rows={30} focused={null} color={false} data={BASE_DATA} />,
			140
		)

		// The rows keep their place (the input area's height is fixed) and each says it has nothing — never a
		// fabricated system, an empty token list, or a zeroed channel.
		expect(text).toContain("locale-head")
		expect(text).not.toContain("us (auto)")
		expect(text).not.toContain("not fed")
		expect(frameLines(text)).toHaveLength(30)
	})

	it("renders the demo's result sections in the output pane", async () => {
		// 40 rows so the whole list is inside the scroll window — at 30 the candidates section is legitimately
		// below the fold, which the scroll test covers.
		const text = await renderInkToString(
			<DebugFrame
				columns={140}
				rows={40}
				focused={null}
				color={false}
				data={{ ...BASE_DATA, trace: TRACE, timing: { parse: 3.2, resolve: 10.5, total: 13.7 } }}
			/>,
			140
		)

		for (const heading of ["components", "kind", "timing", "resolved", "hierarchy", "candidates"]) {
			expect(text).toContain(heading)
		}

		expect(text).toContain("house_number")
		expect(text).toContain("structured_address")
		// The component's own confidence, off the tree node — the demo's ConfidenceCell column.
		expect(text).toContain("0.99")
		expect(text).toContain("3.2 ms")
		expect(text).toContain("wof:101715829")
		// The runner-up candidate, which only the candidates section carries.
		expect(text).toContain("43.66, -70.25")
	})

	it("scrolls the output pane by whole lines without moving anything else", async () => {
		const render = (scrollOffset: number): Promise<string> =>
			renderInkToString(
				<DebugFrame
					columns={140}
					rows={24}
					focused="output"
					color={false}
					scrollOffset={scrollOffset}
					data={{ ...BASE_DATA, trace: TRACE }}
				/>,
				140
			)

		const top = await render(0)
		const scrolled = await render(3)

		// The window advertises itself, and the first section scrolls out of view.
		expect(top).toContain("1-")
		expect(scrolled).toContain("4-")
		expect(top).toContain("components")
		expect(scrolled).not.toContain("components")
		expect(frameLines(scrolled)).toHaveLength(24)
	})

	it("shows the key hints on an interactive frame and says so on a static one", async () => {
		const interactive = await renderInkToString(
			<DebugFrame columns={140} rows={30} focused="input" color={false} data={BASE_DATA} />,
			140
		)

		const staticFrame = await renderInkToString(
			<DebugFrame columns={140} rows={30} focused={null} color={false} data={BASE_DATA} />,
			140
		)

		expect(interactive).toContain("Tab focus")
		expect(interactive).toContain("q/Esc quit")
		expect(staticFrame).toContain("static frame")
		expect(staticFrame).not.toContain("Tab focus")
	})

	it("sizes a map frame from mapPaneCellSize so MapPane renders it without dropping any chrome", async () => {
		const columns = 100
		const rows = 30
		const cellSize = mapPaneCellSize(columns, rows)
		const cellCount = cellSize.columns * cellSize.rows
		// Every cell inked with a distinctive marker char, so a dropped frame row is visible directly (a naive
		// total-line-count check can't tell "rendered" from "silently clipped" — Ink doesn't grow a Box past its
		// declared `height` when children overflow it; it drops rows to fit, which keeps the outer line count
		// unchanged and would pass a line-count-only assertion).
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
				data={{ ...BASE_DATA, frame, mapNote: null, trace: TRACE }}
			/>,
			columns
		)

		const lines = frameLines(text)
		const markedLineCount = lines.filter((line) => line.includes("#")).length

		// Every requested frame row actually rendered — an undercounted chrome budget clips rows (and/or the title)
		// to fit MapPane's declared box height instead of growing past it.
		expect(markedLineCount).toBe(cellSize.rows)
		expect(text).toContain("map")
		expect(text).toContain("test attribution")
		expect(lines).toHaveLength(rows)
	})

	it("keeps the pane budgets in step with the frame's fixed chrome", async () => {
		// The two exported budgets are the same arithmetic seen from two panes: input area (9) + footer (1) is what
		// both subtract before their own chrome. Asserting the pair here is what catches a row added to the input
		// area without the map viewport or the scroll window being told.
		expect(mapPaneCellSize(100, 30)).toEqual({ columns: 48, rows: 16 })
		expect(outputPaneCapacity(30)).toBe(17)

		// And the claim they encode: a frame sized to the map budget still fits the terminal exactly.
		const text = await renderInkToString(
			<DebugFrame columns={100} rows={30} focused={null} color={false} data={BASE_DATA} />,
			100
		)

		expect(frameLines(text)).toHaveLength(30)
	})
})
