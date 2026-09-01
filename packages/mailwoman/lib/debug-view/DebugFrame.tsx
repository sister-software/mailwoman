/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The pure debug-view layout: an input area (the raw query, its parsed span ribbon, and the model-evidence rows)
 *   above a two-pane row (the resolved output on the left, the map render on the right), with one line of key hints
 *   along the bottom. Every value comes from props — no hook reaches for stdin/stdout/terminal size, so the same tree
 *   renders identically through `renderInkToString` (a component test, or a `--once` static capture) and through Ink's
 *   interactive `render()`.
 *
 *   The content mirrors the docs demo's dev mode (`/debug` → `<ModelVisualizer>` + the result panel), section for
 *   section, minus its emissions heatmap — a matrix of pieces × labels is not a terminal row, and the priors that
 *   moved those emissions are named on the decode row instead. The row vocabulary lives in `trace-rows.ts`, the output
 *   pane's line list in `output-lines.ts`; both are pure and unit-tested without a render.
 *
 *   Layout arithmetic (explicit, not measured after the fact — see AGENTS.md's "no post-hoc measurement" rule):
 *
 *   - Input area height is a fixed {@link INPUT_ROW_HEIGHT} (9): two border rows plus seven content rows — the input
 *     line, the span ribbon, then the five evidence rows (system, locale head, tokens, channels, decode). Each
 *     evidence row is ONE `<Text wrap="truncate">`: a row that wrapped would push the box past its declared height,
 *     which Ink resolves by silently dropping a row (see the marker-fill note below), so truncation is what keeps the
 *     arithmetic true at any width.
 *   - The footer takes {@link FOOTER_ROW_HEIGHT} (1) off the bottom.
 *   - The two panes get the remainder: `rows - INPUT_ROW_HEIGHT - FOOTER_ROW_HEIGHT`.
 *   - The output pane takes `floor(columns / 2)`; the map pane takes what's left, so the two always sum to `columns`
 *     regardless of parity.
 *   - {@link mapPaneCellSize} hands a caller (the live command, sizing the actual map-tui renderer viewport) the map
 *     pane's usable CONTENT cell budget: pane width minus its own two border columns
 *     ({@link MAP_PANE_CHROME_COLUMNS}); pane height minus MapPane's own four chrome rows — top+bottom border, the
 *     title line, and the attribution line ({@link MAP_PANE_CHROME_ROWS}) — so a frame built to exactly these
 *     dimensions fills MapPane without any row getting clipped. Measured 2026-08-13: Ink does NOT grow a `Box` past a
 *     fixed `height` when its children need more room — it silently DROPS rows (observed: the title line disappeared
 *     first, then a trailing frame line) rather than overflowing the terminal output, so an undercounted chrome budget
 *     is invisible to a plain output-line-count check. Verified in `DebugFrame.test.tsx` by filling every frame cell
 *     with a marker character and counting marked lines against `cellSize.rows`, plus asserting the title and
 *     attribution both still appear.
 *   - The output pane slices its own line list to what fits ({@link outputPaneCapacity}) rather than letting Ink drop
 *     the overflow, for the same reason: a dropped row is invisible, and this one scrolls.
 */

import { Badge, Spinner } from "@inkjs/ui"
import { losslessSegments, type AddressNode, type AddressTree } from "@mailwoman/core/decoder"
import { frameToANSILines, type MapFrame } from "@mailwoman/map-tui"
import { Box, Text } from "ink"
import React, { memo, useMemo } from "react"

import { outputLines, type OutputLine } from "#debug-view/output-lines"
import { tagColor } from "#debug-view/tag-colors"
import { channelsRow, decodeRow, localeHeadRow, systemRow, tokensRow } from "#debug-view/trace-rows"
import type { GeocodeResult } from "#geocode-result"
import type { GeocodeTrace } from "#geocode-session"

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
	/**
	 * The session's decode-path evidence for this run (`GeocodeRun.trace`). Absent on a session opened without tracing,
	 * or on a bundle that could not produce one — the evidence rows then say so rather than showing zeros.
	 */
	trace?: GeocodeTrace
	/**
	 * The session's per-phase wall clock (`GeocodeRun.timing`). Absent ⇒ the timing section is omitted.
	 */
	timing?: Record<string, number>
}

export interface DebugFrameProps {
	data: DebugData
	columns: number
	rows: number
	/**
	 * Null = static render (no focus chrome, and the footer says so instead of listing keys).
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
	 * First visible line of the output pane's list. The pane owns the slice so the caller's `data` identity stays stable
	 * across a scroll — which is what keeps the map frame from re-rendering on an arrow key.
	 */
	scrollOffset?: number
	/**
	 * Map-pane SGR color. Callers pass `!$public.NO_COLOR` — Ink/chalk honor NO_COLOR on their own, raw SGR does not.
	 */
	color: boolean
}

//#endregion

//#region Layout constants

/**
 * Border (2) + the input line (1) + the span ribbon (1) + the five evidence rows (5). See the file header.
 */
const INPUT_ROW_HEIGHT = 9

/**
 * The key-hint footer's single line.
 */
const FOOTER_ROW_HEIGHT = 1

/**
 * MapPane's own top+bottom border rows, plus its title line, plus its attribution line — the chrome `mapPaneCellSize`
 * must subtract from the pane row's height so a requested frame fills the pane exactly. Counted directly off
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
 * OutputPane's own chrome: top+bottom border (2) plus its title line (1).
 */
const OUTPUT_PANE_CHROME_ROWS = 3

/**
 * The height of the row holding the two panes.
 */
function paneRowHeight(rows: number): number {
	return rows - INPUT_ROW_HEIGHT - FOOTER_ROW_HEIGHT
}

/**
 * The map pane's usable content-cell budget for the map-tui renderer viewport: pane width minus its own border columns,
 * pane-row height minus MapPane's own chrome rows. Exported so a live command can request a frame already sized to fit
 * MapPane without overflow.
 */
export function mapPaneCellSize(columns: number, rows: number): { columns: number; rows: number } {
	return {
		columns: columns - Math.floor(columns / 2) - MAP_PANE_CHROME_COLUMNS,
		rows: paneRowHeight(rows) - MAP_PANE_CHROME_ROWS,
	}
}

/**
 * How many output lines are visible at once — the scroll window's height. Exported so a caller clamping its scroll
 * offset uses the pane's own arithmetic instead of a second copy of it.
 */
export function outputPaneCapacity(rows: number): number {
	return Math.max(0, paneRowHeight(rows) - OUTPUT_PANE_CHROME_ROWS)
}

//#endregion

//#region Shared helpers

const FOCUS_BORDER_COLOR = "cyan"
const UNFOCUSED_BORDER_COLOR = "gray"

function borderColorFor(pane: DebugPane, focused: DebugPane | null): string {
	return focused === pane ? FOCUS_BORDER_COLOR : UNFOCUSED_BORDER_COLOR
}

/**
 * A pane's title text, suffixed with a focus caret when it's the focused pane.
 */
function paneTitle(label: string, pane: DebugPane, focused: DebugPane | null): string {
	return `${label}${focused === pane ? " ◀" : ""}`
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

/**
 * The demo's confidence tiers (`react/pipeline/ConfidenceCell.tsx`): high at 0.8, medium at 0.5. Same cuts, so a
 * component that reads green in the browser reads green here.
 */
const HIGH_CONFIDENCE_MIN = 0.8
const MID_CONFIDENCE_MIN = 0.5

function confidenceColor(confidence: number): string {
	if (confidence >= HIGH_CONFIDENCE_MIN) return "green"

	return confidence >= MID_CONFIDENCE_MIN ? "yellow" : "red"
}

//#endregion

//#region Input area

/**
 * One evidence row: a dim fixed-width label and the value, truncated as ONE text so the row can never wrap.
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

//#endregion

//#region Output pane

/**
 * The label column of a field row, INCLUDING its trailing space — a component nested three deep (` house_number`) is 18
 * characters, so a narrower pad would run the label into its value.
 */
const OUTPUT_LABEL_WIDTH = 19

function OutputRow(props: { line: OutputLine }): React.ReactElement {
	const { line } = props

	if (line.kind === "error") {
		// `@inkjs/ui`'s StatusMessage would be the natural fit and is deliberately NOT used: its message `<Text>`
		// carries no wrap mode, so a long resolver error wraps to a second row and pushes a row out of a
		// fixed-height pane — the silent-drop failure this file's header measures. Same figure, one row, truncated.
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
				// The badge's text is wrapped in a `<Text>` because `Badge` UPPERCASES a plain-string child, and these
				// two badges carry machine values (`address_point`, `structured_address`) a reader copies into a flag
				// or a gauntlet row. The chip is the improvement; the shouting is not.
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
 * Takes the four fields it reads rather than the whole {@link DebugData} bag, for the same reason {@link MapPane} does:
 * `data` gets a new identity on every rendered map frame, and a pane that re-renders on someone else's pan is a `memo`
 * that buys nothing.
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

//#endregion

//#region Map pane

/**
 * The expensive pane, and the one that depends on nothing the input row changes — so it takes the fields it reads
 * rather than the shared {@link DebugData} bag, which is what lets `memo` see stable props across a keystroke.
 *
 * Know what this buys and what it does not. It removes React's reconciliation of the 28 `<Text>` rows: worth 2.3 ms of
 * the 12.9 ms keystroke against React's DEVELOPMENT build, and inside the noise floor against its production build
 * (measured 2026-08-13, 120×36, six interleaved pairs each). It cannot touch the dominant cost, because Ink's
 * `render-node-to-output` walks the whole yoga tree and re-serializes it every frame no matter which subtrees React
 * skipped — that is what `incrementalRendering` is for, and the two are complementary rather than redundant.
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

//#endregion

//#region Footer

/**
 * The key hints, in the order a new reader needs them: how to move focus, then what the focused pane does, then how to
 * leave. A static capture has no keyboard at all, so it says what it is instead of advertising keys that do nothing.
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

//#endregion

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
