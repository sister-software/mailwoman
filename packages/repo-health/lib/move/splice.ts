import { stringifyJSON } from "@mailwoman/core/json"

/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Replaces strings at known offsets for both the move planner and the move writer.
 */

/**
 * A replacement of the text between two offsets.
 */
export interface TextEdit {
	/**
	 * The text that must appear between the offsets.
	 *
	 * A mismatch throws, because it means the offsets have drifted.
	 */
	expected: string
	replacement: string
	start: number
	end: number
	/**
	 * Whether the offsets include a pair of quotes.
	 * The edit keeps the original quote character.
	 */
	quoted: boolean
}

/**
 * Applies every edit to `text`, starting from the end so earlier offsets stay valid.
 *
 * `label` identifies the file in the error message.
 */
export function spliceText(label: string, text: string, edits: readonly TextEdit[]): string {
	let spliced = text

	for (const edit of [...edits].toSorted((a, b) => b.start - a.start)) {
		const found = spliced.slice(edit.start, edit.end)

		if (!found.includes(edit.expected)) {
			throw new Error(`${label}: ${stringifyJSON(edit.expected)} is not at ${edit.start}–${edit.end} (${found})`)
		}

		const quote = edit.quoted ? (found[0] ?? '"') : ""

		spliced = `${spliced.slice(0, edit.start)}${quote}${edit.replacement}${quote}${spliced.slice(edit.end)}`
	}

	return spliced
}
