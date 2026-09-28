/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file H3 cell primitives — the index types and the widen/shorten conversions.

 */

import { cellToParent, isValidCell } from "h3-js"
import type { Tagged } from "type-fest"

/**
 * The finest resolution H3 defines; resolutions run `[0, H3_MAX_RESOLUTION]`.
 */
export const H3_MAX_RESOLUTION = 15

/**
 * A H3 cell index, full 64 bits, written as 15 lowercase hex characters matching `^[0-9a-f]{15}$`.
 */
export type H3Cell = Tagged<string, "H3Cell">

/**
 * Is `value` a real H3 cell index, delegating to h3-js because the hex surface
 * shape is necessary but not sufficient.
 */
export function isH3Cell(value: string): value is H3Cell {
	return isValidCell(value)
}

/**
 * A H3 cell index with its mode and resolution nibbles removed — the low 52 bits, fixed width.
 */
export type H3CellShort = Tagged<string, "H3CellShort">

/**
 * Number of hex characters in the short form: 52 bits, a 7-bit base cell followed by fifteen 3-bit digits.
 */
const SHORT_CELL_HEX_LENGTH = 13

/**
 * Mask selecting the low 52 bits of a cell index — everything but the mode and resolution nibbles.
 */
const SHORT_CELL_MASK = 0xf_ff_ff_ff_ff_ff_ffn

/**
 * Strip the mode and resolution nibbles off a full H3 cell index, keeping the base cell
 * and the whole digit path, zero-padded to a fixed 13 characters so hex order matches integer order.
 */
export function shortenH3Cell(cell: H3Cell): H3CellShort {
	const cellBigInt = BigInt(`0x${cell}`)
	const h3CellShortBigInt = cellBigInt & SHORT_CELL_MASK

	return h3CellShortBigInt.toString(16).padStart(SHORT_CELL_HEX_LENGTH, "0") as H3CellShort
}

/**
 * Rebuild a full H3 cell index from a short cell captured at `resolution`, throwing
 * when the resolution is out of range or the pair does not name a valid cell.
 */
export function expandH3Cell(h3CellShort: H3CellShort, resolution = H3_MAX_RESOLUTION): H3Cell {
	if (!Number.isInteger(resolution) || resolution < 0 || resolution > H3_MAX_RESOLUTION) {
		throw new RangeError(`H3 resolution must be an integer in [0, ${H3_MAX_RESOLUTION}], received ${resolution}.`)
	}

	if (h3CellShort.length > SHORT_CELL_HEX_LENGTH) {
		throw new RangeError(
			`Short H3 cell "${h3CellShort}" is ${h3CellShort.length} hex characters, wider than the ${SHORT_CELL_HEX_LENGTH} a short cell holds.`
		)
	}

	// Accept an unpadded short cell too — an integer round-tripped through `toString(16)` loses its leading zeros.
	const shortHex = h3CellShort.padStart(SHORT_CELL_HEX_LENGTH, "0")
	const cell = `8${resolution.toString(16)}${shortHex}` as H3Cell

	if (!isValidCell(cell)) {
		throw new Error(
			`Short H3 cell "${h3CellShort}" does not name a valid cell at resolution ${resolution} — it was captured at a different resolution.`
		)
	}

	return cell
}

/**
 * The full H3 index for a short cell held as an integer, stored at `resolution`,
 * through {@link expandH3Cell} so an invalid pair throws rather than reaching `compactCells`.
 */
export function expandShortCellInt(shortCell: number, resolution: number): H3Cell {
	return expandH3Cell(shortCell.toString(16).padStart(SHORT_CELL_HEX_LENGTH, "0") as H3CellShort, resolution)
}

/**
 * Pack an H3 cell into the short-cell integer used as a clustered B-tree key across layer databases —
 * 52 bits, inside `Number.MAX_SAFE_INTEGER` and SQLite's signed 64-bit integer column.
 */
export function shortCellToInt(cell: H3Cell): number {
	return Number(BigInt(`0x${shortenH3Cell(cell)}`))
}

/**
 * The one resolution a set of stored short cells was captured at, recovered by keeping
 * the resolution at which a short cell expands to a valid index.
 */
export function recoverShortCellResolution(cells: readonly number[], context = "layer coverage"): number {
	if (!cells.length) {
		throw new Error(`${context}: the coverage layer holds no cells — there is no resolution to recover`)
	}

	let recovered: number | undefined

	for (const cell of cells) {
		const short = BigInt(cell).toString(16).padStart(SHORT_CELL_HEX_LENGTH, "0") as H3CellShort
		const valid: number[] = []

		for (let resolution = 0; resolution <= H3_MAX_RESOLUTION; resolution++) {
			try {
				expandH3Cell(short, resolution)
				valid.push(resolution)
			} catch {
				// A resolution the short cell does not expand at — every cell expands at exactly one.
			}
		}

		if (valid.length !== 1) {
			throw new Error(
				`${context}: coverage cell ${cell} expands at ${valid.length} resolutions (${valid.join(", ") || "none"}) — it is not a short H3 cell this layer can be probed by`
			)
		}

		const resolution = valid[0]!

		if (recovered === undefined) {
			recovered = resolution

			continue
		}

		if (recovered !== resolution) {
			throw new Error(
				`${context}: the coverage table mixes resolutions (${recovered} and ${resolution}) — a single-resolution probe would read every cell at the other resolution as unsurveyed`
			)
		}
	}

	return recovered!
}

/**
 * Reconstruct a short-cell int's ancestor at a coarser resolution from the stored cell itself
 * rather than a centroid, which can land in a different parent.
 */
export function shortCellToParentInt(shortCell: number, from: number, to: number): number {
	return shortCellToInt(cellToParent(expandShortCellInt(shortCell, from), to) as H3Cell)
}
