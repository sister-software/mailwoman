/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Replacing strings at known offsets, shared by the planner and the writer.
 *
 *   The planner needs the result in memory — a resolver proving a replacement has to read the manifest as the plan
 *   will leave it, not as it stands — and the writer needs it on disk. One function serves both, because two
 *   implementations of "splice these strings" would agree on every case anyone tested and differ on the one nobody
 *   did.
 */

export interface TextEdit {
	/**
	 * What must sit at these offsets. A mismatch throws rather than writing: an offset that has drifted names a different
	 * string with exactly the same confidence as the right one.
	 */
	expected: string
	replacement: string
	start: number
	end: number
	/**
	 * Whether the offsets bracket a quote pair. A module specifier and a manifest target are quoted, so the quote
	 * character is read from the text and written back — a single-quoted specifier stays single-quoted and the formatter
	 * has nothing to undo. A path in a shell command or a sentence is not.
	 */
	quoted: boolean
}

/**
 * `text` with every edit applied, spliced from the end so no offset shifts under a later one.
 */
export function spliceText(label: string, text: string, edits: readonly TextEdit[]): string {
	let spliced = text

	for (const edit of [...edits].toSorted((a, b) => b.start - a.start)) {
		const found = spliced.slice(edit.start, edit.end)

		if (!found.includes(edit.expected)) {
			throw new Error(`${label}: ${JSON.stringify(edit.expected)} is not at ${edit.start}–${edit.end} (${found})`)
		}

		const quote = edit.quoted ? (found[0] ?? '"') : ""

		spliced = `${spliced.slice(0, edit.start)}${quote}${edit.replacement}${quote}${spliced.slice(edit.end)}`
	}

	return spliced
}
