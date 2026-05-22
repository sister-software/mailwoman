/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { Segment, SegmentSeparator } from "./types.js"

/**
 * Comma / newline / tab separate segments. Locale-aware grammar reserved for future (JP whitespace,
 * KR honorifics). Default rules apply when no locale-specific override exists.
 */
export function segment(text: string, _locale?: string): Segment[] {
	const segments: Segment[] = []
	if (text.length === 0) return segments

	let start = 0
	let lastSeparator: SegmentSeparator = null
	let index = 0

	const flush = (end: number, separator: SegmentSeparator) => {
		// Trim leading + trailing whitespace from each segment but record the original span.
		const raw = text.slice(start, end)
		const leftPad = raw.match(/^\s*/)![0].length
		const rightPad = raw.match(/\s*$/)![0].length
		const innerStart = start + leftPad
		const innerEnd = end - rightPad
		if (innerEnd > innerStart) {
			segments.push({
				span: { start: innerStart, end: innerEnd, body: text.slice(innerStart, innerEnd) },
				body: text.slice(innerStart, innerEnd),
				index,
				separator: lastSeparator,
			})
			index += 1
		}
		lastSeparator = separator
	}

	for (let i = 0; i < text.length; i++) {
		const ch = text[i]
		if (ch === ",") {
			flush(i, "comma")
			start = i + 1
		} else if (ch === "\n") {
			flush(i, "newline")
			start = i + 1
		} else if (ch === "\t") {
			flush(i, "tab")
			start = i + 1
		} else if (ch === ";") {
			flush(i, "comma") // semicolon treated as comma-equivalent
			start = i + 1
		}
	}
	flush(text.length, null)

	return segments
}
