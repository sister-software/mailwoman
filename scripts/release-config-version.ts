/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The `release.config.json` version bump as a PURE textual replacement (#1891). The file is
 *   oxfmt-formatted — single-line arrays, an order the generic parse-then-stringify write path would
 *   reformat wholesale — and its `weights` block is the model identity a code-only release must
 *   never touch. So the bump edits exactly one line, and refuses anything it cannot do exactly.
 */

/**
 * Replace the top-level `"version"` line, requiring exactly one match of the current value. Throws when the line is
 * absent (a reformatted or hand-edited file — bump it by hand and fix the formatter drift) or when the current version
 * does not match (the sync check's job, restated here so a caller cannot skip it).
 */
export function bumpReleaseConfigVersion(text: string, currentVersion: string, targetVersion: string): string {
	const line = `\t"version": ${JSON.stringify(currentVersion)},`
	const first = text.indexOf(line)

	if (first === -1) {
		throw new Error(
			`release.config.json carries no line ${JSON.stringify(line)} — either its version is not ` +
				`${currentVersion} (version drift; see the sync check) or the file's formatting changed.`
		)
	}

	if (text.indexOf(line, first + 1) !== -1) {
		throw new Error(`release.config.json contains ${JSON.stringify(line)} more than once — refusing to guess.`)
	}

	return text.replace(line, `\t"version": ${JSON.stringify(targetVersion)},`)
}
