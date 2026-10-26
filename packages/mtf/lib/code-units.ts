/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Code units: each digit run or alphanumeric code in an address, segmented as one unit (#2845).
 */

import type { TextSpan } from "@mailwoman/query-shape/types"

/**
 * One code unit and its half-open UTF-16 offsets into the text.
 */
export type CodeUnit = TextSpan

/**
 * A run of ASCII letters and digits holding at least one digit, with a hyphen
 * allowed between two digits (`12345-6789`, `100-0005`).
 *
 * The run must not touch another ASCII letter or digit on either side, so `B2B` and `SW1A` are whole units.
 * A Han or Kana character next to a run is a boundary, because Japanese and Chinese
 * addresses write a block number straight after its place name (`丸の内1-9-1`).
 */
const CODE_UNIT = /(?<![A-Za-z0-9])(?=[A-Za-z0-9-]*\d)[A-Za-z0-9]+(?:-(?=\d)[A-Za-z0-9]+)*(?![A-Za-z0-9])/gu

/**
 * Every code unit in `text`, left to right.
 *
 * A word-piece vocabulary makes a postcode one piece only by memorizing that code.
 * A code unit keeps the whole code together and describes it by its shape instead.
 */
export function segmentCodeUnits(text: string): CodeUnit[] {
	return [...text.matchAll(CODE_UNIT)].map((match) => ({
		text: match[0],
		start: match.index,
		end: match.index + match[0].length,
	}))
}

/**
 * The unit's character pattern: `9` per digit, `A` per letter, other characters
 * kept (`SW1A` → `AA9A`, `12345-6789` → `99999-9999`).
 */
export function codeUnitPattern(unit: string): string {
	return unit.replaceAll(/\d/g, "9").replaceAll(/[A-Za-z]/g, "A")
}
