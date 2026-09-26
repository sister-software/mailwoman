/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file What a command is called, separated from where its file sits.
 *
 *   A prefix directory is transparent to the command path — `build/postcode/codepoint.js` answers
 *   `build postcode-codepoint`, the convention `repo-health`'s `prefix-directories` check enforces — while a
 *   namespace directory such as `gazetteer/` stays a path segment the user types.
 */

/**
 * Every filesystem path a command segment can name, fewest splits first —
 * `postcode-codepoint` answers `["postcode-codepoint"]` and `["postcode", "codepoint"]` —
 * with the literal spelling tried before any directory reading.
 */
export function commandPathCandidates(segment: string): string[][] {
	const parts = segment.split("-")
	const candidates: string[][] = []

	// One bit per hyphen: set makes a directory boundary, clear keeps the hyphen in the segment.
	for (let mask = 0; mask < 2 ** (parts.length - 1); mask++) {
		const built: string[] = [parts[0] ?? ""]

		for (let index = 1; index < parts.length; index++) {
			if (mask & (1 << (index - 1))) {
				built.push(parts[index] ?? "")
			} else {
				built[built.length - 1] = `${built.at(-1)}-${parts[index]}`
			}
		}

		candidates.push(built)
	}

	return candidates.toSorted((a, b) => a.length - b.length)
}

/**
 * Whether `directory` is layout rather than something the user types, which the declared name
 * alone separates: `gazetteer/inspect/fst.tsx` declaring `fst` makes `inspect` a namespace,
 * while `gazetteer/build/postcode/codepoint.tsx` declaring `postcode-codepoint` makes `postcode` layout.
 */
export function isPrefixDirectory(directory: string, name: string): boolean {
	return name.startsWith(`${directory}-`)
}

const DECLARED_NAME = /\bspec\s*=\s*\{\s*name\s*:\s*["'`]([^"'`]+)["'`]/u

/**
 * The command name a compiled module declares, read from its text rather than imported
 * because importing a command module runs it and pulls Ink, a resolver, and sometimes a
 * database handle; a module whose spec cannot be found falls back to its filename.
 */
export function declaredCommandName(source: string, fallback: string): string {
	return DECLARED_NAME.exec(source)?.[1] ?? fallback
}
