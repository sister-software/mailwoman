/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file H3 cell primitives — the index types and the widen/shorten conversions.
 *
 *   Split out from `./index.ts` because these carry no dependency on `GeoPoint`, while the
 *   point-valued helpers there do. `geometries/point.ts` needs the primitives and is itself imported
 *   by `./index.ts`, so keeping them together closed an import cycle.
 */

import { isValidCell } from "h3-js"
import type { Tagged } from "type-fest"

/**
 * The finest resolution H3 defines. Resolutions run `[0, H3_MAX_RESOLUTION]`.
 */
export const H3_MAX_RESOLUTION = 15

/**
 * A H3 cell index, full 64 bits.
 *
 * Written as 15 hex characters because the top nibble of a cell index is always zero: bit 63 is reserved, and the 4-bit
 * mode field that follows is `1` for a cell, which lands entirely inside the second nibble. That is why every cell
 * index printed here begins with `8`.
 *
 * @type {string}
 * @title H3 Cell Index
 * @pattern ^[0-9a-f]{15}$
 */
export type H3Cell = Tagged<string, "H3Cell">

/**
 * Is `value` a real H3 cell index?
 *
 * Delegates to h3-js rather than testing the surface shape. The shape is necessary but nowhere near sufficient —
 * `000000000000000`, `fffffffffffffff` and `123456789abcdef` are all fifteen lowercase hex characters and none of them
 * is a cell. A guard that returns `value is H3Cell` on those hands the caller a branded type it has not earned, and the
 * error surfaces later inside h3-js with no reference to where the bad value entered.
 */
export function isH3Cell(value: string): value is H3Cell {
	return isValidCell(value)
}

/**
 * A H3 cell index with its mode and resolution nibbles removed — the low 52 bits, fixed width.
 *
 * @type {string}
 * @title H3 Cell Index (Short)
 * @pattern ^[0-9a-f]{13}$
 */
export type H3CellShort = Tagged<string, "H3CellShort">

/**
 * Number of hex characters in the short form. 52 bits: a 7-bit base cell followed by fifteen 3-bit digits.
 */
const SHORT_CELL_HEX_LENGTH = 13

/**
 * Mask selecting the low 52 bits of a cell index — everything but the mode and resolution nibbles.
 */
const SHORT_CELL_MASK = 0xf_ff_ff_ff_ff_ff_ffn

/**
 * Strip the mode and resolution nibbles off a full H3 cell index, keeping the base cell and the whole digit path.
 *
 * The digits past the cell's own resolution are all `7` in a valid index, so nothing is discarded and nothing is
 * inferred: the short form carries the cell losslessly for every resolution, and {@link expandH3Cell} reverses it
 * exactly once you tell it which resolution the cell was captured at.
 *
 * Zero-padded to a fixed 13 characters, so the hex form orders and compares the same way the integer
 * {@link shortCellToInt} packs does. Base cells 0-7 leave the leading nibble zero, and an unpadded string would both
 * mis-sort and mis-expand.
 */
export function shortenH3Cell(cell: H3Cell): H3CellShort {
	const cellBigInt = BigInt(`0x${cell}`)
	const h3CellShortBigInt = cellBigInt & SHORT_CELL_MASK

	return h3CellShortBigInt.toString(16).padStart(SHORT_CELL_HEX_LENGTH, "0") as H3CellShort
}

/**
 * Rebuild a full H3 cell index from a short cell captured at `resolution`.
 *
 * The short form drops only the mode and resolution nibbles, so reconstruction is a straight concatenation: `"8"` (cell
 * mode) + the resolution nibble + the 52 bits verbatim. The result is the identical index `latLngToCell` would have
 * produced at that resolution.
 *
 * `resolution` is a required piece of external knowledge — a short cell does not name its own resolution, so the caller
 * has to supply the one the cell was shortened at. Supplying the wrong one is caught rather than tolerated: a mismatch
 * leaves digits past the stated resolution set to something other than `7`, which H3 rejects, and this throws instead
 * of returning an index that downstream `cellToParent` calls would refuse with `Cell arguments had incompatible
 * resolutions`.
 *
 * @throws {RangeError} If `resolution` is not an integer in `[0, 15]`, or `h3CellShort` is wider than 13 hex
 *   characters.
 * @throws {Error} If the short cell and resolution do not together name a valid H3 cell.
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
 * Pack an H3 cell into the short-cell integer used as a clustered B-tree key across layer databases (poi.db, bdc.db,
 * address-id). 52 bits, so it stays inside `Number.MAX_SAFE_INTEGER` and SQLite's signed 64-bit integer column alike.
 */
export function shortCellToInt(cell: H3Cell): number {
	return Number(BigInt(`0x${shortenH3Cell(cell)}`))
}

/**
 * The one resolution a set of stored short cells was captured at.
 *
 * A short cell drops the resolution nibble, so a table of them does not say what resolution it is keyed at — and every
 * `layer_coverage` reader needs that number to derive a probe's coverage cell. It is recoverable because
 * {@link expandH3Cell} validates: a short cell expands to a valid index at EXACTLY ONE resolution, so trying all
 * sixteen and keeping the one that survives is an exact answer rather than an inference.
 *
 * SHARED RATHER THAN COPIED, because both failure modes it names are silent in a second copy. A table that mixes
 * resolutions read at one of them reports every cell at the other as unsurveyed, and an empty table read as "resolution
 * 0" puts every probe in the same cell. `packages/mailwoman/observations/absence-route.ts` re-exports this under its
 * own name; `@mailwoman/coastal` calls it directly.
 *
 * @param context Names the caller in both messages, so a failure says which reader refused.
 * @throws {Error} When `cells` is empty, when a value is not a short cell, or when the set mixes resolutions.
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
				// A resolution the short cell does not expand at. Every cell expands at exactly one, so this is the
				// ordinary case for fifteen of the sixteen probes.
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
