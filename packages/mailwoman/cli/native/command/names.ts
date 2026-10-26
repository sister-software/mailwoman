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
 * The spelling a typed command segment has: a lowercase letter, then letters, digits and single hyphens.
 */
const COMMAND_SEGMENT = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u

/**
 * The most hyphens whose directory readings are tried.
 * A longer segment is tried only as spelled.
 */
const MAX_SPLIT_HYPHENS = 6

/**
 * Every filesystem path a command segment can name, fewest splits first —
 * `postcode-codepoint` answers `["postcode-codepoint"]` and `["postcode", "codepoint"]` —
 * with the literal spelling tried before any directory reading.
 */
export function commandPathCandidates(segment: string): string[][] {
	// An address such as `100% Banco` or `1-2-3-4-5-6-7-8` arrives here as the first positional of `parse`.
	// Only a lowercase name can be a command, and its hyphen readings grow as 2^hyphens.
	if (!COMMAND_SEGMENT.test(segment)) return []

	const parts = segment.split("-")

	if (parts.length - 1 > MAX_SPLIT_HYPHENS) return [[segment]]
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
 * Whether `directory` is layout rather than a user-entered command name.
 *
 * `gazetteer/inspect/fst.tsx` declares `fst`, so `inspect` is a namespace.
 * `gazetteer/build/postcode/codepoint.tsx` declares `postcode-codepoint`, so `postcode` is layout.
 */
export function isPrefixDirectory(directory: string, name: string): boolean {
	return name.startsWith(`${directory}-`)
}

/**
 * Whether a directory is layout for every command it holds: it offers no command of its own
 * and each declared name under it starts with the directory's name.
 *
 * A directory with no commands is neither a prefix nor a namespace, so it answers false.
 */
export function isPrefixDirectoryFor(directory: string, declaredNames: readonly string[]): boolean {
	return declaredNames.length > 0 && declaredNames.every((name) => isPrefixDirectory(directory, name))
}

const DECLARED_NAME = /\bspec\s*=\s*\{\s*name\s*:\s*["'`]([^"'`]+)["'`]/u

/**
 * The command name a compiled module declares, read from its text rather than imported because
 * importing a command module runs it and pulls Ink, a resolver plus sometimes a database handle.
 *
 * A module whose spec cannot be found falls back to its filename.
 */
export function declaredCommandName(source: string, fallback: string): string {
	return DECLARED_NAME.exec(source)?.[1] ?? fallback
}
