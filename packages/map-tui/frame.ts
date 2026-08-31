/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

/**
 * Braille frame value + conversion for map-tui's debug view.
 *
 * `rasterizeToFrame` turns an `RGBAGrid` (drawn by ./raster.ts) into a `MapFrame`: one codepoint and one packed color
 * per cell. The braille dither/luminance work is asciify's — `FrameRasterizer` subclasses `AsciifyTerminal` with a
 * no-op sink purely to reach its protected `_computeBrailleCells`, `_cellChars`, `_cellColors`, so this module never
 * re-implements the dot math. `frameToANSILines` and `overlayText` then work on the plain `MapFrame` value, with no
 * further asciify dependency; `blitFrame` is the seam back the other way, for callers driving a live terminal.
 */

import { AsciifyTerminal, SGR_RESET } from "@sister.software/asciify/tui"

import type { RGBAGrid } from "#raster"
import type { RGB } from "#style"

/**
 * A rendered braille frame: one codepoint and one packed color per cell, row-major.
 */
export interface MapFrame {
	columns: number
	rows: number
	/**
	 * Codepoint per cell, row-major (braille U+2800.. or overlay text).
	 */
	chars: Uint32Array
	/**
	 * 0xRRGGBB per cell; 0 = inkless.
	 */
	colors: Uint32Array
	attribution: string
}

/**
 * Reaches asciify's protected braille conversion from the outside. Constructed fresh per {@link rasterizeToFrame} call
 * — cheap, since the state is just two typed arrays sized to the cell grid. The `write` sink is never invoked: this
 * class only ever calls `_computeBrailleCells` directly, never `rasterize`/`flush`.
 */
class FrameRasterizer extends AsciifyTerminal {
	constructor(columns: number, rows: number) {
		super({ write: () => true, columns, rows }, { mode: "braille", colorDepth: "truecolor", synchronizedOutput: false })
		this.setSize(columns, rows)
	}

	toCells(buffer: Uint8ClampedArray): { chars: Uint32Array; colors: Uint32Array } {
		this._computeBrailleCells(buffer, false)

		return { chars: this._cellChars.slice(), colors: this._cellColors.slice() }
	}
}

/**
 * Converts a 2×4-subpixel RGBA grid into braille cells. Grid must be `columns * 2` x `rows * 4`.
 *
 * @throws If the grid's dimensions don't match `columns * 2` x `rows * 4` — a caller sizing bug, not something to
 *   silently clip.
 */
export function rasterizeToFrame(grid: RGBAGrid, columns: number, rows: number, attribution: string): MapFrame {
	if (grid.width !== columns * 2 || grid.height !== rows * 4) {
		throw new Error(
			`rasterizeToFrame: grid is ${grid.width}x${grid.height}, expected ${columns * 2}x${rows * 4} for ${columns}x${rows} cells`
		)
	}

	const rasterizer = new FrameRasterizer(columns, rows)
	const { chars, colors } = rasterizer.toCells(grid.data)

	return { columns, rows, chars, colors, attribution }
}

/**
 * One SGR-styled string per row. `color: false` strips styling (NO_COLOR consumers).
 *
 * Inkless cells (packed color 0) never emit a color escape, matching asciify's own damage emitter — a cell going from
 * inked to inkless shouldn't touch color state. Each styled line ends with the SGR reset so a truncated terminal write
 * never bleeds color into whatever follows.
 */
export function frameToANSILines(frame: MapFrame, options?: { color?: boolean }): string[] {
	const colorEnabled = options?.color ?? true
	const lines: string[] = []

	for (let row = 0; row < frame.rows; row++) {
		let line = ""
		let activeColor = -1

		for (let column = 0; column < frame.columns; column++) {
			const cellIndex = row * frame.columns + column
			const char = frame.chars[cellIndex]!
			const color = frame.colors[cellIndex]!
			const inked = color !== 0

			if (colorEnabled && inked && color !== activeColor) {
				line += `\u001B[38;2;${(color >> 16) & 0xff};${(color >> 8) & 0xff};${color & 0xff}m`
				activeColor = color
			}

			line += char === 0 ? " " : String.fromCodePoint(char)
		}

		lines.push(colorEnabled ? line + SGR_RESET : line)
	}

	return lines
}

/**
 * Writes text into cells (clipped); occupied is the label-collision bitmap, updated in place.
 *
 * When `occupied` is given, every target cell plus one cell of padding on each side is checked before anything is
 * written — a single colliding cell rejects the whole label rather than partially overlaying it. Without `occupied`,
 * writes proceed unconditionally (still clipped to the frame's bounds) and always report success.
 */
export function overlayText(
	frame: MapFrame,
	column: number,
	row: number,
	text: string,
	color: number,
	occupied?: Uint8Array
): boolean {
	if (row < 0 || row >= frame.rows) return false

	const codePoints = Array.from(text)

	if (occupied) {
		for (let i = 0; i < codePoints.length; i++) {
			const cellColumn = column + i

			for (let padding = -1; padding <= 1; padding++) {
				const checkColumn = cellColumn + padding

				if (checkColumn < 0 || checkColumn >= frame.columns) continue

				if (occupied[row * frame.columns + checkColumn]) return false
			}
		}
	}

	for (let i = 0; i < codePoints.length; i++) {
		const cellColumn = column + i

		if (cellColumn < 0 || cellColumn >= frame.columns) continue

		const cellIndex = row * frame.columns + cellColumn

		frame.chars[cellIndex] = codePoints[i]!.codePointAt(0)!
		frame.colors[cellIndex] = color

		if (occupied) {
			occupied[cellIndex] = 1
		}
	}

	return true
}

/**
 * Packs RGB channels into the frame's 0xRRGGBB color representation. Shared with Task 8's marker colors so both sides
 * of the frame boundary agree on the packing.
 */
export function rgbToPacked(color: RGB): number {
	return (color[0] << 16) | (color[1] << 8) | color[2]
}

/**
 * Codepoint written for a cell the frame left empty. `MapFrame` stores 0 there; `AsciifyTerminal` expects a real
 * character, and normalizes a space to the inkless color itself.
 */
const SPACE_CODEPOINT = 0x20

/**
 * Writes a frame's cells into an `AsciifyTerminal`'s current frame. Call `flush()` afterwards to emit the damage.
 *
 * The frame's packed color is the exact representation asciify canonicalizes truecolor to, so this is a copy and not a
 * conversion — the channels are unpacked here only because {@linkcode AsciifyTerminal.setCell} takes them apart. Cells
 * beyond the terminal's own grid are dropped by `setCell`, so a frame larger than the pane clips rather than throws.
 */
export function blitFrame(terminal: AsciifyTerminal, frame: MapFrame): void {
	for (let row = 0; row < frame.rows; row++) {
		for (let column = 0; column < frame.columns; column++) {
			const cellIndex = row * frame.columns + column
			const char = frame.chars[cellIndex]!
			const color = frame.colors[cellIndex]!

			terminal.setCell(column, row, char === 0 ? SPACE_CODEPOINT : char, [
				(color >> 16) & 0xff,
				(color >> 8) & 0xff,
				color & 0xff,
			])
		}
	}
}
