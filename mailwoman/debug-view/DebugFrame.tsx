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
 *     viewport) the map pane's usable CONTENT cell budget — pane width minus its own two border
 *     columns, bottom-row height minus the map pane's two border rows.
 */

import type { AddressNode, AddressTree } from "@mailwoman/core/decoder"
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
 * The map pane's usable content-cell budget for the map-tui renderer viewport: pane width/height minus its own border
 * rows/columns. Exported so a live command can request a frame already sized to fit.
 */
export function mapPaneCellSize(columns: number, rows: number): { columns: number; rows: number } {
	return { columns: columns - Math.floor(columns / 2) - 2, rows: rows - 4 - 2 }
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
 * The tree's leaf nodes (no children — the finest-grained spans the model actually assigned a tag to), in source order.
 * DFS traversal order doesn't matter here since the result is sorted by `start`.
 */
function leafNodes(tree: AddressTree): AddressNode[] {
	const leaves: AddressNode[] = []
	const stack: AddressNode[] = [...tree.roots]

	while (stack.length) {
		const node = stack.pop()!

		if (node.children.length) {
			stack.push(...node.children)
		} else {
			leaves.push(node)
		}
	}

	return leaves.toSorted((a, b) => a.start - b.start)
}

//#endregion

//#region Input row

function InputBar(props: {
	data: DebugData
	focused: DebugPane | null
	inputField: React.ReactNode | undefined
	columns: number
}): React.ReactElement {
	const leaves = leafNodes(props.data.tree)

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
				{leaves.map((node, i) => (
					<Text key={`segment-${i}`} backgroundColor={tagColor(node.tag)}>
						{` ${node.value} `}
					</Text>
				))}
				<Text> </Text>
				{leaves.map((node, i) => (
					<Text key={`legend-${i}`} color={tagColor(node.tag)}>
						{i > 0 ? " " : ""}
						{node.tag}
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
					width={outputWidth}
					height={bottomHeight}
				/>
				<MapPane data={props.data} focused={props.focused} color={props.color} width={mapWidth} height={bottomHeight} />
			</Box>
		</Box>
	)
}
