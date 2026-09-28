/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { Badge, Spinner } from "@inkjs/ui"
import { losslessSegments, type AddressNode, type AddressTree } from "@mailwoman/core/decoder"
import { frameToANSILines, type MapFrame } from "@mailwoman/map-tui"
import { Box, Text } from "ink"
import React, { memo, useMemo } from "react"

import { outputLines, type OutputLine } from "#debug-view/output-lines"
import { tagColor } from "#debug-view/tag-colors"
import { channelsRow, decodeRow, localeHeadRow, systemRow, tokensRow } from "#debug-view/trace-rows"
import type { GeocodeResult } from "#geocode/result"
import type { GeocodeTrace } from "#geocode/session"

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
	/**
	 * The session's decode-path evidence for this run, absent when the session was opened without tracing.
	 * The evidence rows then say so rather than showing zeros.
	 */
	trace?: GeocodeTrace
	/**
	 * The session's per-phase wall clock.
	 * Absent means the timing section is omitted.
	 */
	timing?: Record<string, number>
}

export interface DebugFrameProps {
	data: DebugData
	columns: number
	rows: number
	/**
	 * Null means static render with no focus chrome.
	 * The footer says so instead of listing keys.
	 */
	focused: DebugPane | null
	/**
	 * Interactive-only children slot for the input row, undefined on a static render.
	 */
	inputField?: React.ReactNode
	busy?: boolean
	/**
	 * A failed re-run's message, rendered red at the top of the output pane because the
	 * interactive session keeps the previous result on screen when a geocode rejects.
	 */
	errorNote?: string | null
	/**
	 * First visible line of the output pane's list, owned by the pane so the caller's
	 * `data` identity stays stable across a scroll.
	 */
	scrollOffset?: number
	/**
	 * Map-pane SGR color.
	 *
	 * Callers pass `!$public.NO_COLOR` because raw SGR does not honor `NO_COLOR` the way Ink/chalk do.
	 */
	color: boolean
}

/**
 * Border (2) + the input line (1) + the span ribbon (1) + the five evidence rows (5).
 */
const INPUT_ROW_HEIGHT = 9

const FOOTER_ROW_HEIGHT = 1

/**
 * MapPane's own top+bottom border rows, plus its title line, plus its attribution line,
 * counted off {@link MapPane}'s render tree.
 */
const MAP_PANE_CHROME_ROWS = 4

/**
 * MapPane's own left+right border columns.
 *
 * Its title and attribution lines run inside that same width and add no column chrome.
 */
const MAP_PANE_CHROME_COLUMNS = 2

/**
 * OutputPane's own chrome: top+bottom border (2) plus its title line (1).
 */
const OUTPUT_PANE_CHROME_ROWS = 3

function paneRowHeight(rows: number): number {
	return rows - INPUT_ROW_HEIGHT - FOOTER_ROW_HEIGHT
}

/**
 * The map pane's usable content-cell budget for the map-tui renderer viewport, exported
 * so a live command can request a frame already sized to fit MapPane.
 */
export function mapPaneCellSize(columns: number, rows: number): { columns: number; rows: number } {
	return {
		columns: columns - Math.floor(columns / 2) - MAP_PANE_CHROME_COLUMNS,
		rows: paneRowHeight(rows) - MAP_PANE_CHROME_ROWS,
	}
}

/**
 * How many output lines are visible at once, exported so a caller clamping its scroll
 * offset uses the pane's own arithmetic rather than a second copy.
 */
export function outputPaneCapacity(rows: number): number {
	return Math.max(0, paneRowHeight(rows) - OUTPUT_PANE_CHROME_ROWS)
}

const FOCUS_BORDER_COLOR = "cyan"
const UNFOCUSED_BORDER_COLOR = "gray"

function borderColorFor(pane: DebugPane, focused: DebugPane | null): string {
	return focused === pane ? FOCUS_BORDER_COLOR : UNFOCUSED_BORDER_COLOR
}

function paneTitle(label: string, pane: DebugPane, focused: DebugPane | null): string {
	return `${label}${focused === pane ? " ◀" : ""}`
}

type Tag = AddressNode["tag"]

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
 * One tile of the span ribbon: a run of `value` colored by `tag`, or an `unknown`
 * (uncovered) run when `tag` is `undefined`.
 */
export interface RibbonSegment {
	value: string
	tag: Tag | undefined
}

/**
 * Tile `tree.raw` into ribbon segments for the input row, splitting each covered run at
 * {@link tagOwnership} boundaries so every chip carries exactly one tag's color.
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

/**
 * The demo's confidence tiers, matched so a component that reads green in the browser reads green here.
 */
const HIGH_CONFIDENCE_MIN = 0.8
const MID_CONFIDENCE_MIN = 0.5

function confidenceColor(confidence: number): string {
	if (confidence >= HIGH_CONFIDENCE_MIN) return "green"

	return confidence >= MID_CONFIDENCE_MIN ? "yellow" : "red"
}

/**
 * One evidence row: a dim fixed-width label and the value, truncated as one text so the row can never wrap.
 */
const EVIDENCE_LABEL_WIDTH = 12

function EvidenceRow(props: { label: string; value: string }): React.ReactElement {
	return (
		<Text wrap="truncate">
			<Text dimColor>{props.label.padEnd(EVIDENCE_LABEL_WIDTH)}</Text>
			{props.value}
		</Text>
	)
}

const InputBar = memo(function InputBar(props: {
	input: string
	tree: AddressTree
	trace: GeocodeTrace | undefined
	focused: DebugPane | null
	inputField: React.ReactNode | undefined
	columns: number
}): React.ReactElement {
	const { segments, legendTags } = useMemo(() => {
		const parsed = ribbonSegments(props.tree)
		const tags: Tag[] = []

		for (const segment of parsed) {
			if (segment.tag && !tags.includes(segment.tag)) {
				tags.push(segment.tag)
			}
		}

		return { segments: parsed, legendTags: tags }
	}, [props.tree])

	const { trace } = props

	return (
		<Box
			borderStyle="round"
			borderColor={borderColorFor("input", props.focused)}
			flexDirection="column"
			width={props.columns}
			height={INPUT_ROW_HEIGHT}
		>
			<Box>{props.inputField ?? <Text>{props.input}</Text>}</Box>
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
			<EvidenceRow label="system" value={systemRow(trace)} />
			<EvidenceRow label="locale-head" value={localeHeadRow(trace)} />
			<EvidenceRow label="tokens" value={tokensRow(trace)} />
			<EvidenceRow label="channels" value={channelsRow(trace)} />
			<EvidenceRow label="decode" value={decodeRow(trace)} />
		</Box>
	)
})

/**
 * The label column of a field row, including its trailing space.
 *
 * A component nested three deep (` house_number`) is 18 characters.
 */
const OUTPUT_LABEL_WIDTH = 19

function OutputRow(props: { line: OutputLine }): React.ReactElement {
	const { line } = props

	if (line.kind === "error") {
		// `@inkjs/ui`'s StatusMessage is deliberately not used: its message `<Text>` carries no
		// wrap mode, so a long resolver error would wrap and push a row out of a fixed-height pane.
		return (
			<Text color="red" wrap="truncate">
				✖ {line.label}
			</Text>
		)
	}

	if (line.kind === "heading") {
		return (
			<Text bold color="cyan" wrap="truncate">
				{line.label}
			</Text>
		)
	}

	return (
		<Text wrap="truncate">
			<Text color={line.tag ? tagColor(line.tag) : undefined}>{`${line.label} `.padEnd(OUTPUT_LABEL_WIDTH)}</Text>
			{line.badge ? (
				// The badge's text is wrapped in a `<Text>` because `Badge` uppercases a plain-string child,
				// These badges carry machine values (`address_point`, `structured_address`) that a reader copies.
				<Badge color={line.badgeColor ?? "cyan"}>
					<Text>{line.badge}</Text>
				</Badge>
			) : (
				(line.value ?? "")
			)}
			{line.detail ? <Text dimColor> {line.detail}</Text> : null}
			{line.confidence == null ? null : (
				<Text color={confidenceColor(line.confidence)}> {line.confidence.toFixed(2)}</Text>
			)}
		</Text>
	)
}

/**
 * Takes the fields it reads rather than the whole {@link DebugData} bag,
 * so `memo` sees stable props across a pan.
 */
const OutputPane = memo(function OutputPane(props: {
	result: GeocodeResult
	tree: AddressTree
	trace: GeocodeTrace | undefined
	timing: Record<string, number> | undefined
	focused: DebugPane | null
	busy: boolean | undefined
	errorNote: string | null | undefined
	scrollOffset: number
	width: number
	height: number
}): React.ReactElement {
	const capacity = Math.max(0, props.height - OUTPUT_PANE_CHROME_ROWS)

	const lines = useMemo(
		() =>
			outputLines({
				result: props.result,
				tree: props.tree,
				...(props.trace ? { trace: props.trace } : {}),
				...(props.timing ? { timing: props.timing } : {}),
				errorNote: props.errorNote,
			}),
		[props.result, props.tree, props.trace, props.timing, props.errorNote]
	)

	const offset = Math.max(0, Math.min(props.scrollOffset, Math.max(0, lines.length - 1)))
	const visible = lines.slice(offset, offset + capacity)

	return (
		<Box
			borderStyle="round"
			borderColor={borderColorFor("output", props.focused)}
			flexDirection="column"
			width={props.width}
			height={props.height}
		>
			<Box>
				<Text>{paneTitle("output", "output", props.focused)}</Text>
				<Text dimColor>
					{" "}
					{offset + 1}-{Math.min(lines.length, offset + capacity)}/{lines.length}
				</Text>
				{props.busy ? <Spinner /> : null}
			</Box>
			{visible.map((line, i) => (
				<OutputRow key={offset + i} line={line} />
			))}
		</Box>
	)
})

/**
 * The expensive pane, taking the fields it reads rather than the shared {@link DebugData} bag
 * so `memo` sees stable props across a keystroke.
 */
const MapPane = memo(function MapPane(props: {
	frame: MapFrame | null
	mapNote: string | null
	focused: DebugPane | null
	color: boolean
	width: number
	height: number
}): React.ReactElement {
	const { frame, mapNote } = props
	const lines = useMemo(() => (frame ? frameToANSILines(frame, { color: props.color }) : null), [frame, props.color])

	return (
		<Box
			borderStyle="round"
			borderColor={borderColorFor("map", props.focused)}
			flexDirection="column"
			width={props.width}
			height={props.height}
		>
			<Text>{paneTitle("map", "map", props.focused)}</Text>
			{frame && lines ? (
				<>
					{lines.map((line, i) => (
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
})

/**
 * The key hints, in the order a new reader needs them.
 *
 * A static capture has no keyboard and says what it is instead.
 */
const KEY_HINTS = "Tab focus   ←↑↓→ pan/scroll   +/- zoom   0 recenter   Enter re-run   q/Esc quit"
const STATIC_HINT = "static frame — keyboard controls on a TTY"

function Footer(props: { focused: DebugPane | null; columns: number }): React.ReactElement {
	return (
		<Box width={props.columns} height={FOOTER_ROW_HEIGHT}>
			<Text dimColor wrap="truncate">
				{props.focused ? KEY_HINTS : STATIC_HINT}
			</Text>
		</Box>
	)
}

export function DebugFrame(props: DebugFrameProps): React.ReactElement {
	const paneHeight = paneRowHeight(props.rows)
	const outputWidth = Math.floor(props.columns / 2)
	const mapWidth = props.columns - outputWidth

	return (
		<Box flexDirection="column" width={props.columns} height={props.rows}>
			<InputBar
				input={props.data.input}
				tree={props.data.tree}
				trace={props.data.trace}
				focused={props.focused}
				inputField={props.inputField}
				columns={props.columns}
			/>
			<Box flexDirection="row" width={props.columns} height={paneHeight}>
				<OutputPane
					result={props.data.result}
					tree={props.data.tree}
					trace={props.data.trace}
					timing={props.data.timing}
					focused={props.focused}
					busy={props.busy}
					errorNote={props.errorNote}
					scrollOffset={props.scrollOffset ?? 0}
					width={outputWidth}
					height={paneHeight}
				/>
				<MapPane
					frame={props.data.frame}
					mapNote={props.data.mapNote}
					focused={props.focused}
					color={props.color}
					width={mapWidth}
					height={paneHeight}
				/>
			</Box>
			<Footer focused={props.focused} columns={props.columns} />
		</Box>
	)
}
