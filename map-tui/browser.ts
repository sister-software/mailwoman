/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

/**
 * The interactive map browser — a full-screen, alternate-screen terminal app over `MapRenderer`.
 *
 * `MapBrowser` owns exactly three things the frame-first library deliberately does not: terminal MODE (alternate
 * screen, hidden cursor, raw stdin, mouse reporting), viewport STATE (center, zoom, drag anchor), and the write path.
 * Frames still come from `MapRenderer.renderFrame` as values; `blitFrame` copies one into an `AsciifyTerminal`, whose
 * damage diff decides what actually goes down the wire.
 *
 * The pane is the terminal minus its bottom row, which is the status bar. `AsciifyTerminal` is told that size and never
 * addresses a cell outside it, so the two writers never fight over a cell.
 *
 * Every mode change made in {@link MapBrowser.start} is undone by {@link MapBrowser.restore}, which is idempotent so a
 * signal handler, an `exit` hook and the normal path can all call it. A terminal left in raw mode with mouse reporting
 * on is not a recoverable shell, so restore is the one operation that must survive any exit path.
 */

import { AsciifyTerminal, cursorTo, SGR_RESET } from "@sister.software/asciify/tui"

import { blitFrame } from "./frame.ts"
import { decodeInputChunk, type MapTUIInput, MOUSE_DISABLE, MOUSE_ENABLE } from "./input.ts"
import { lonLatToWorldPx, worldPxToLonLat } from "./mercator.ts"
import { MapRenderer } from "./renderer.ts"
import type { TileSource } from "./tile-source.ts"

const ALT_SCREEN_ENTER = "\u001B[?1049h"
const ALT_SCREEN_EXIT = "\u001B[?1049l"
const CURSOR_HIDE = "\u001B[?25l"
const CURSOR_SHOW = "\u001B[?25h"
const CLEAR_SCREEN = "\u001B[2J"
const CLEAR_LINE = "\u001B[2K"
const REVERSE_VIDEO = "\u001B[7m"

/**
 * Subpixel dimensions of one braille cell — the unit every viewport-space conversion below works in.
 */
const SUBPIXELS_PER_COLUMN = 2
const SUBPIXELS_PER_ROW = 4

/**
 * Rows reserved at the bottom of the terminal for the status bar.
 */
const STATUS_BAR_ROWS = 1

/**
 * Size assumed when the output reports none. A pty opened without a window size (util-linux `script`, some CI
 * harnesses) reports 0 columns and 0 rows, which is neither an error nor a usable grid.
 */
const FALLBACK_COLUMNS = 80
const FALLBACK_ROWS = 24

/**
 * Floor on the pane's dimensions. Below this the renderer is being asked for a grid too small to mean anything, and a
 * zero-sized one would divide by zero in the projection.
 */
const MIN_COLUMNS = 4
const MIN_PANE_ROWS = 1

/**
 * How much of the pane one arrow-key press travels. An eighth is far enough to feel like progress at a keystroke and
 * short enough that the next frame still overlaps the last.
 */
const PAN_FRACTION = 0.125

/**
 * Web-Mercator's latitude cutoff — the projection is undefined at the poles, and the square tile pyramid ends here.
 */
const MERCATOR_LATITUDE_LIMIT = 85.05112878

const COORDINATE_DIGITS = 4

/**
 * The subset of a readable stream the browser drives. Structural so `process.stdin` satisfies it without the app being
 * welded to it — the same reasoning asciify applies to its own output type.
 */
export interface BrowserInput {
	setRawMode?(mode: boolean): unknown
	setEncoding(encoding: "utf8"): unknown
	resume(): unknown
	pause(): unknown
	on(event: "data", listener: (chunk: string) => void): unknown
	off(event: "data", listener: (chunk: string) => void): unknown
}

/**
 * The subset of a writable terminal the browser drives.
 */
export interface BrowserOutput {
	write(chunk: string): unknown
	columns?: number | undefined
	rows?: number | undefined
	on(event: "resize", listener: () => void): unknown
	off(event: "resize", listener: () => void): unknown
}

export interface MapBrowserOptions {
	source: TileSource
	input: BrowserInput
	output: BrowserOutput
	lat: number
	lon: number
	zoom: number
}

interface DragAnchor {
	column: number
	row: number
	centerLon: number
	centerLat: number
	zoom: number
	moved: boolean
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max)
}

/**
 * Wraps a longitude into [-180, 180) so panning past the antimeridian continues rather than running off the pyramid.
 */
function wrapLongitude(lon: number): number {
	const wrapped = (((lon + 180) % 360) + 360) % 360

	return wrapped - 180
}

/**
 * Clips a string to a cell budget, counting codepoints — the status bar's arrows are one cell each but two UTF-16
 * units, and `String.prototype.slice` would cut one in half.
 */
function clipToCells(text: string, cells: number): string {
	const codePoints = Array.from(text)

	return codePoints.length <= cells ? text : codePoints.slice(0, cells).join("")
}

export class MapBrowser {
	private readonly source: TileSource
	private readonly renderer: MapRenderer
	private readonly input: BrowserInput
	private readonly output: BrowserOutput
	private readonly terminal: AsciifyTerminal

	private centerLon: number
	private centerLat: number
	private zoom: number

	private columns = FALLBACK_COLUMNS
	private paneRows = FALLBACK_ROWS - STATUS_BAR_ROWS

	private drag: DragAnchor | null = null
	private renderInFlight = false
	private renderQueued = false
	private started = false
	private restored = false
	private error: string | null = null
	private resolveExit: ((code: number) => void) | null = null

	private readonly onData = (chunk: string): void => {
		for (const event of decodeInputChunk(chunk)) {
			this.handleInput(event)
		}
	}

	private readonly onResize = (): void => {
		this.measure()
		this.output.write(CLEAR_SCREEN)
		this.terminal.invalidate()
		this.scheduleRender()
	}

	constructor(options: MapBrowserOptions) {
		this.source = options.source
		this.renderer = new MapRenderer(options.source)
		this.input = options.input
		this.output = options.output

		this.centerLon = wrapLongitude(options.lon)
		this.centerLat = clamp(options.lat, -MERCATOR_LATITUDE_LIMIT, MERCATOR_LATITUDE_LIMIT)
		this.zoom = clamp(Math.round(options.zoom), options.source.minZoom, options.source.maxZoom)

		this.terminal = new AsciifyTerminal(this.output, {
			mode: "braille",
			colorDepth: "truecolor",
			synchronizedOutput: true,
		})
	}

	/**
	 * Runs until the user quits, resolving with the process exit code (0 for a normal quit, 130 for Ctrl+C). The terminal
	 * is restored before this resolves.
	 */
	async run(): Promise<number> {
		this.start()

		const code = await new Promise<number>((resolve) => {
			this.resolveExit = resolve
		})

		this.restore()

		return code
	}

	/**
	 * Asks the browser to exit with a code. Safe to call from a signal handler, and a no-op once an exit is already under
	 * way.
	 */
	requestExit(code: number): void {
		const resolve = this.resolveExit

		if (!resolve) return

		this.resolveExit = null
		resolve(code)
	}

	/**
	 * Enters the alternate screen and takes over input. Paired with {@link restore}.
	 */
	start(): void {
		if (this.started) return

		this.started = true
		this.output.write(ALT_SCREEN_ENTER + CURSOR_HIDE + CLEAR_SCREEN + MOUSE_ENABLE)

		this.input.setRawMode?.(true)
		this.input.setEncoding("utf8")
		this.input.resume()
		this.input.on("data", this.onData)
		this.output.on("resize", this.onResize)

		this.measure()
		this.scheduleRender()
	}

	/**
	 * Puts the terminal back exactly as it was found. Idempotent: the normal exit path, a signal handler and a
	 * process-level `exit` hook may each call it.
	 */
	restore(): void {
		if (!this.started || this.restored) return

		this.restored = true

		this.input.off("data", this.onData)
		this.output.off("resize", this.onResize)
		this.input.setRawMode?.(false)
		this.input.pause()

		this.output.write(MOUSE_DISABLE + SGR_RESET + CURSOR_SHOW + ALT_SCREEN_EXIT)
	}

	private handleInput(event: MapTUIInput): void {
		switch (event.kind) {
			case "quit":
				return this.requestExit(0)

			case "interrupt":
				return this.requestExit(130)

			case "pan":
				return this.panBySteps(event.dx, event.dy)

			case "zoom":
				return this.zoomBy(event.delta, null)

			case "wheel":
				return this.zoomBy(event.delta, { column: event.column, row: event.row })

			case "press":
				return this.beginDrag(event.column, event.row)

			case "drag":
				return this.continueDrag(event.column, event.row)

			case "release":
				return this.endDrag()
		}
	}

	private panBySteps(dx: number, dy: number): void {
		const columnStep = Math.max(1, Math.round(this.columns * PAN_FRACTION))
		const rowStep = Math.max(1, Math.round(this.paneRows * PAN_FRACTION))

		this.panByCells(dx * columnStep, dy * rowStep)
		this.scheduleRender()
	}

	/**
	 * Moves the center by a cell delta, through world pixels so the step is the same distance on screen at every latitude
	 * — the naive degrees-per-keypress version crawls at the equator and sprints near the poles.
	 */
	private panByCells(columns: number, rows: number): void {
		const center = lonLatToWorldPx(this.centerLon, this.centerLat, this.zoom)

		const next = worldPxToLonLat(
			center.x + columns * SUBPIXELS_PER_COLUMN,
			center.y + rows * SUBPIXELS_PER_ROW,
			this.zoom
		)

		this.setCenter(next.lon, next.lat)
	}

	private setCenter(lon: number, lat: number): void {
		this.centerLon = wrapLongitude(lon)
		this.centerLat = clamp(lat, -MERCATOR_LATITUDE_LIMIT, MERCATOR_LATITUDE_LIMIT)
	}

	/**
	 * Longitude/latitude at the center of a pane cell.
	 */
	private cellToLonLat(column: number, row: number): { lon: number; lat: number } {
		const center = lonLatToWorldPx(this.centerLon, this.centerLat, this.zoom)
		const originX = center.x - (this.columns * SUBPIXELS_PER_COLUMN) / 2
		const originY = center.y - (this.paneRows * SUBPIXELS_PER_ROW) / 2

		return worldPxToLonLat(
			originX + column * SUBPIXELS_PER_COLUMN + SUBPIXELS_PER_COLUMN / 2,
			originY + row * SUBPIXELS_PER_ROW + SUBPIXELS_PER_ROW / 2,
			this.zoom
		)
	}

	/**
	 * Zooms one or more whole levels. With an anchor cell (the wheel's pointer), the center shifts so whatever was under
	 * the pointer stays under it; without one, the pane center holds.
	 */
	private zoomBy(delta: number, anchor: { column: number; row: number } | null): void {
		const next = clamp(this.zoom + delta, this.source.minZoom, this.source.maxZoom)

		if (next === this.zoom) return

		if (!anchor || !this.withinPane(anchor.column, anchor.row)) {
			this.zoom = next
			this.scheduleRender()

			return
		}

		const target = this.cellToLonLat(anchor.column, anchor.row)

		this.zoom = next

		const landed = this.cellToLonLat(anchor.column, anchor.row)
		const center = lonLatToWorldPx(this.centerLon, this.centerLat, this.zoom)
		const targetPx = lonLatToWorldPx(target.lon, target.lat, this.zoom)
		const landedPx = lonLatToWorldPx(landed.lon, landed.lat, this.zoom)

		const corrected = worldPxToLonLat(
			center.x + (targetPx.x - landedPx.x),
			center.y + (targetPx.y - landedPx.y),
			this.zoom
		)

		this.setCenter(corrected.lon, corrected.lat)
		this.scheduleRender()
	}

	private withinPane(column: number, row: number): boolean {
		return column >= 0 && column < this.columns && row >= 0 && row < this.paneRows
	}

	private beginDrag(column: number, row: number): void {
		if (!this.withinPane(column, row)) return

		this.drag = {
			column,
			row,
			centerLon: this.centerLon,
			centerLat: this.centerLat,
			zoom: this.zoom,
			moved: false,
		}
	}

	/**
	 * Pans relative to where the drag STARTED, not the previous motion report. Accumulating per-report deltas would
	 * drift, since each one is rounded to a whole cell.
	 */
	private continueDrag(column: number, row: number): void {
		const anchor = this.drag

		if (!anchor || anchor.zoom !== this.zoom) return

		anchor.moved = true

		const center = lonLatToWorldPx(anchor.centerLon, anchor.centerLat, anchor.zoom)

		const next = worldPxToLonLat(
			center.x + (anchor.column - column) * SUBPIXELS_PER_COLUMN,
			center.y + (anchor.row - row) * SUBPIXELS_PER_ROW,
			anchor.zoom
		)

		this.setCenter(next.lon, next.lat)
		this.scheduleRender()
	}

	/**
	 * A press and release with no motion between them is a click, which centers the map — mapscii's behavior, and the
	 * reason centering waits for the release rather than acting on the press.
	 */
	private endDrag(): void {
		const anchor = this.drag

		this.drag = null

		if (!anchor || anchor.moved) return

		// A wheel event between press and release moved the map out from under the click, so the cell no longer names
		// the place the user pointed at.
		if (anchor.zoom !== this.zoom) return

		const target = this.cellToLonLat(anchor.column, anchor.row)

		this.setCenter(target.lon, target.lat)
		this.scheduleRender()
	}

	/**
	 * Reads the terminal's size and re-sizes the pane around the status bar.
	 */
	private measure(): void {
		// `||` and not `??`: a pty with no window size reports 0, which is as unusable as absent.
		const columns = Math.floor(this.output.columns || FALLBACK_COLUMNS)
		const rows = Math.floor(this.output.rows || FALLBACK_ROWS)

		this.columns = Math.max(MIN_COLUMNS, columns)
		this.paneRows = Math.max(MIN_PANE_ROWS, rows - STATUS_BAR_ROWS)

		this.terminal.setSize(this.columns, this.paneRows)
	}

	/**
	 * Requests a frame. Renders never overlap: a request arriving mid-render is coalesced into one more pass, so a held
	 * arrow key queues a single redraw rather than a backlog of them.
	 */
	private scheduleRender(): void {
		if (this.renderInFlight) {
			this.renderQueued = true

			return
		}

		void this.renderLoop()
	}

	private async renderLoop(): Promise<void> {
		this.renderInFlight = true

		try {
			do {
				this.renderQueued = false

				await this.renderOnce()
			} while (this.renderQueued && !this.restored)
		} finally {
			this.renderInFlight = false
		}
	}

	private async renderOnce(): Promise<void> {
		const viewport = {
			centerLon: this.centerLon,
			centerLat: this.centerLat,
			zoom: this.zoom,
			columns: this.columns,
			rows: this.paneRows,
		}

		try {
			const frame = await this.renderer.renderFrame(viewport)

			// The terminal may have been restored while the tiles were in flight; writing then would paint over the
			// user's shell.
			if (this.restored) return

			// A resize between the request and now leaves the frame the wrong shape for the pane — drop it and let the
			// resize's own render answer instead.
			if (frame.columns !== this.columns || frame.rows !== this.paneRows) return

			this.error = null

			blitFrame(this.terminal, frame)
			this.terminal.flush()
			this.drawStatusBar(frame.attribution)
		} catch (error) {
			this.error = error instanceof Error ? error.message : String(error)

			if (!this.restored) {
				this.drawStatusBar("")
			}
		}
	}

	private statusText(attribution: string): string {
		if (this.error) return `⚠ ${this.error}  q quit`

		const lat = this.centerLat.toFixed(COORDINATE_DIGITS)
		const lon = this.centerLon.toFixed(COORDINATE_DIGITS)
		const status = `${lat},${lon} z${this.zoom}  ←↑↓→ pan  +/- zoom  q quit`

		if (!attribution.length) return status

		const credited = `${status}  © ${attribution}`

		// Attribution is a courtesy to the tile source, never a reason to push the controls off the bar.
		return Array.from(credited).length < this.columns ? credited : status
	}

	private drawStatusBar(attribution: string): void {
		// One cell short of the width: writing the bottom-right cell leaves some terminals in a pending-wrap state.
		const width = Math.max(0, this.columns - 1)
		const line = clipToCells(this.statusText(attribution), width).padEnd(width)

		this.output.write(`${cursorTo(0, this.paneRows)}${CLEAR_LINE}${REVERSE_VIDEO}${line}${SGR_RESET}`)
	}
}
