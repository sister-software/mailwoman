/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The pure three-panel debug-view layout: an input row (the raw query + its parsed span ribbon)
 *   above a two-pane bottom row (the resolved output on the left, the map render on the right). Every
 *   value comes from props — no hook reaches for stdin/stdout/terminal size, so the same tree renders
 *   identically through `renderInkToString` (a component test, or a `--once` static capture) and
 *   through Ink's interactive `render()` (a later task's live command).
 *
 *   Layout arithmetic (explicit, not measured after the fact — see AGENTS.md's "no post-hoc
 *   measurement" rule):
 *
 *   - Input row height is a fixed {@link INPUT_ROW_HEIGHT} (4): two border rows, the input line
 *     (`inputField` or the plain query text), and the span ribbon on one row below it (segments then
 *     the tag legend, packed onto that single row — the fixed height leaves no room for a second).
 *   - The bottom row gets the remainder: `rows - INPUT_ROW_HEIGHT`.
 *   - The output pane takes `floor(columns / 2)`; the map pane takes what's left, so the two always
 *     sum to `columns` regardless of parity.
 *   - {@link mapPaneCellSize} hands a caller (the live command, sizing the actual map-tui renderer
 *     viewport) the map pane's usable CONTENT cell budget: pane width minus its own two border
 *     columns ({@link MAP_PANE_CHROME_COLUMNS}); bottom-row height minus MapPane's own four chrome
 *     rows — top+bottom border, the title line, and the attribution line
 *     ({@link MAP_PANE_CHROME_ROWS}) — so a frame built to exactly these dimensions fills MapPane
 *     without any row getting clipped. Measured 2026-08-13: Ink does NOT grow a `Box` past a fixed
 *     `height` when its children need more room — it silently DROPS rows (observed: the title line
 *     disappeared first, then a trailing frame line) rather than overflowing the terminal output, so
 *     an undercounted chrome budget is invisible to a plain output-line-count check. Verified in
 *     `DebugFrame.test.tsx` by filling every frame cell with a marker character and counting marked
 *     lines against `cellSize.rows`, plus asserting the title and attribution both still appear.
 */

import { losslessSegments, type AddressNode, type AddressTree } from "@mailwoman/core/decoder"
import { frameToANSILines, type MapFrame } from "@mailwoman/map-tui"
import { Box, Text } from "ink"
import type React from "react"

import type { GeocodeResult } from "../geocode-core.ts"
import { tagColor } from "./tag-colors.ts"

//#region Contract

export type DebugPane = "input" | "output" | "map"

export interface DebugData {
	input: string
	tree: AddressTree
	result: GeocodeResult
	frame: MapFrame | null
	/**
	 * Shown in the map pane when frame is null: "no tiles: …" or "unresolved: no coordinate".
	 */
	mapNote: string | null
}

export interface DebugFrameProps {
	data: DebugData
	columns: number
	rows: number
	/**
	 * Null = static render (no focus chrome).
	 */
	focused: DebugPane | null
	/**
	 * Interactive-only children slot for the input row (the text field); static passes undefined and the input renders as
	 * plain text.
	 */
	inputField?: React.ReactNode
	busy?: boolean
	/**
	 * A failed re-run's message, rendered red at the top of the output pane. The interactive session keeps the PREVIOUS
	 * result on screen when a geocode rejects — the failure is one line of news, not a reason to blank three panes — so
	 * the note needs a home that is neither the result nor the map. Static renders pass nothing.
	 */
	errorNote?: string | null
	/**
	 * Map-pane SGR color. Callers pass `$public.NO_COLOR == null` — Ink/chalk honor NO_COLOR on their own, raw SGR does
	 * not.
	 */
	color: boolean
}

//#endregion

//#region Layout constants

/**
 * Border (2) + the input line (1) + the span ribbon (1). See the file header.
 */
const INPUT_ROW_HEIGHT = 4

/**
 * MapPane's own top+bottom border rows, plus its title line, plus its attribution line — the chrome `mapPaneCellSize`
 * must subtract from the bottom row's height so a requested frame fills the pane exactly. Counted directly off
 * {@link MapPane}'s render tree: `borderStyle="round"` (2), the `paneTitle` `<Text>` (1), the right-aligned attribution
 * `<Box><Text>` when a frame is present (1).
 */
const MAP_PANE_CHROME_ROWS = 4

/**
 * MapPane's own left+right border columns. Its title/attribution lines run inside that same width, so they add no
 * additional column chrome.
 */
const MAP_PANE_CHROME_COLUMNS = 2

/**
 * The map pane's usable content-cell budget for the map-tui renderer viewport: pane width minus its own border columns,
 * bottom-row height minus the input row's height AND MapPane's own chrome rows. Exported so a live command can request
 * a frame already sized to fit MapPane without overflow.
 */
export function mapPaneCellSize(columns: number, rows: number): { columns: number; rows: number } {
	return {
		columns: columns - Math.floor(columns / 2) - MAP_PANE_CHROME_COLUMNS,
		rows: rows - INPUT_ROW_HEIGHT - MAP_PANE_CHROME_ROWS,
	}
}

//#endregion

//#region Shared helpers

const FOCUS_BORDER_COLOR = "cyan"
const UNFOCUSED_BORDER_COLOR = "gray"

function borderColorFor(pane: DebugPane, focused: DebugPane | null): string {
	return focused === pane ? FOCUS_BORDER_COLOR : UNFOCUSED_BORDER_COLOR
}

/**
 * A pane's title text, suffixed with a focus caret when it's the focused pane and/or a busy ellipsis.
 */
function paneTitle(label: string, pane: DebugPane, focused: DebugPane | null, busy?: boolean): string {
	return `${label}${busy ? "…" : ""}${focused === pane ? " ◀" : ""}`
}

/**
 * A component tag, or `undefined` for a run no node covers.
 */
type Tag = AddressNode["tag"]

/**
 * Per-character tag ownership over `tree.raw`: for every index some node covers, the tag of the DEEPEST node whose span
 * contains it — a child's tag overrides its ancestor's on the range they share, so a leaf's tag wins where one exists,
 * and a parent's own text that no child covers still gets the parent's tag rather than falling through to "no owner".
 * Indices no node covers at all stay `undefined` (the `losslessSegments` `unknown` runs).
 */
function tagOwnership(tree: AddressTree): (Tag | undefined)[] {
	const owners: (Tag | undefined)[] = new Array(tree.raw.length).fill(undefined)

	const visit = (node: AddressNode): void => {
		const lo = Math.max(0, node.start)
		const hi = Math.min(owners.length, node.end)

		for (let i = lo; i < hi; i++) {
			owners[i] = node.tag
		}

		for (const child of node.children) {
			visit(child)
		}
	}

	for (const root of tree.roots) {
		visit(root)
	}

	return owners
}

/**
 * One tile of the span ribbon: a run of `value` colored by `tag`, or an `unknown` (uncovered) run when `tag` is
 * `undefined`.
 */
export interface RibbonSegment {
	value: string
	tag: Tag | undefined
}

/**
 * Tile `tree.raw` into ribbon segments for the input row.
 *
 * Built on `losslessSegments` (`@mailwoman/core/decoder`, #493) for the covered/`unknown` split — every character of
 * the input belongs to exactly one segment, so the ribbon never silently drops the connector text between spans (the
 * comma-space between a street and a locality, say) the way walking only leaf nodes did. Each `covered` run is further
 * split at {@link tagOwnership} boundaries so every ribbon chip carries exactly one tag's color. Concatenating every
 * segment's `value`, in order, reproduces `tree.raw` exactly — the same round-trip invariant `losslessSegments`
 * guarantees.
 */
export function ribbonSegments(tree: AddressTree): RibbonSegment[] {
	const owners = tagOwnership(tree)
	const segments: RibbonSegment[] = []

	for (const run of losslessSegments(tree)) {
		if (run.kind === "unknown") {
			segments.push({ value: run.value, tag: undefined })

			continue
		}

		let cursor = run.start

		while (cursor < run.end) {
			const tag = owners[cursor]
			let next = cursor + 1

			while (next < run.end && owners[next] === tag) {
				next++
			}

			segments.push({ value: tree.raw.slice(cursor, next), tag })
			cursor = next
		}
	}

	return segments
}

//#endregion

//#region Input row

function InputBar(props: {
	data: DebugData
	focused: DebugPane | null
	inputField: React.ReactNode | undefined
	columns: number
}): React.ReactElement {
	const segments = ribbonSegments(props.data.tree)
	const legendTags: Tag[] = []

	for (const segment of segments) {
		if (segment.tag && !legendTags.includes(segment.tag)) {
			legendTags.push(segment.tag)
		}
	}

	return (
		<Box
			borderStyle="round"
			borderColor={borderColorFor("input", props.focused)}
			flexDirection="column"
			width={props.columns}
			height={INPUT_ROW_HEIGHT}
		>
			<Box>{props.inputField ?? <Text>{props.data.input}</Text>}</Box>
			<Box>
				{segments.map((segment, i) =>
					segment.tag ? (
						<Text key={`segment-${i}`} backgroundColor={tagColor(segment.tag)}>
							{segment.value}
						</Text>
					) : (
						<Text key={`segment-${i}`} dimColor>
							{segment.value}
						</Text>
					)
				)}
				<Text> </Text>
				{legendTags.map((tag, i) => (
					<Text key={`legend-${i}`} color={tagColor(tag)}>
						{i > 0 ? " " : ""}
						{tag}
					</Text>
				))}
			</Box>
		</Box>
	)
}

//#endregion

//#region Output pane

function formatCoordinate(lat: number | null, lon: number | null): string {
	if (lat == null || lon == null) return "unresolved"

	return `${lat}, ${lon}`
}

function HierarchyRow(props: { entry: GeocodeResult["hierarchy"][number] }): React.ReactElement {
	const { entry } = props

	return (
		<Box>
			<Text color={tagColor(entry.tag)}>{entry.tag}</Text>
			<Text> {entry.value}</Text>
			{entry.placeID ? <Text dimColor> {entry.placeID}</Text> : null}
			{entry.lat != null && entry.lon != null ? (
				<Text dimColor>
					{" "}
					({entry.lat}, {entry.lon})
				</Text>
			) : null}
		</Box>
	)
}

function OutputPane(props: {
	data: DebugData
	focused: DebugPane | null
	busy: boolean | undefined
	errorNote: string | null | undefined
	width: number
	height: number
}): React.ReactElement {
	const { result } = props.data

	return (
		<Box
			borderStyle="round"
			borderColor={borderColorFor("output", props.focused)}
			flexDirection="column"
			width={props.width}
			height={props.height}
		>
			<Text>{paneTitle("output", "output", props.focused, props.busy)}</Text>
			{props.errorNote ? <Text color="red">{props.errorNote}</Text> : null}
			<Text>tier: {result.resolution_tier}</Text>
			<Text>coordinate: {formatCoordinate(result.lat, result.lon)}</Text>
			<Text>uncertainty: {result.uncertainty_m == null ? "unknown" : `${result.uncertainty_m} m`}</Text>
			{result.hierarchy.map((entry, i) => (
				<HierarchyRow key={i} entry={entry} />
			))}
		</Box>
	)
}

//#endregion

//#region Map pane

function MapPane(props: {
	data: DebugData
	focused: DebugPane | null
	color: boolean
	width: number
	height: number
}): React.ReactElement {
	const { frame, mapNote } = props.data

	return (
		<Box
			borderStyle="round"
			borderColor={borderColorFor("map", props.focused)}
			flexDirection="column"
			width={props.width}
			height={props.height}
		>
			<Text>{paneTitle("map", "map", props.focused)}</Text>
			{frame ? (
				<>
					{frameToANSILines(frame, { color: props.color }).map((line, i) => (
						<Text key={i}>{line}</Text>
					))}
					<Box justifyContent="flex-end">
						<Text dimColor>{frame.attribution}</Text>
					</Box>
				</>
			) : (
				<Text dimColor>{mapNote}</Text>
			)}
		</Box>
	)
}

//#endregion

export function DebugFrame(props: DebugFrameProps): React.ReactElement {
	const bottomHeight = props.rows - INPUT_ROW_HEIGHT
	const outputWidth = Math.floor(props.columns / 2)
	const mapWidth = props.columns - outputWidth

	return (
		<Box flexDirection="column" width={props.columns} height={props.rows}>
			<InputBar data={props.data} focused={props.focused} inputField={props.inputField} columns={props.columns} />
			<Box flexDirection="row" width={props.columns} height={bottomHeight}>
				<OutputPane
					data={props.data}
					focused={props.focused}
					busy={props.busy}
					errorNote={props.errorNote}
					width={outputWidth}
					height={bottomHeight}
				/>
				<MapPane data={props.data} focused={props.focused} color={props.color} width={mapWidth} height={bottomHeight} />
			</Box>
		</Box>
	)
}
