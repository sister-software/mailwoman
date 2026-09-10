/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file What a command is CALLED, separated from where its file sits.
 *
 *   The router used to read a command's name off its filename, which made the layout a contract: moving
 *   `gazetteer/build/postcode-codepoint.tsx` into `build/postcode/` renamed the command, silently, and
 *   `mailwoman gazetteer build postcode-codepoint` — a name written into built databases as their `builder`
 *   provenance — stopped existing. A file's location is this repository's business; a command's name is the user's.
 *
 *   So a PREFIX DIRECTORY is transparent to the command path: `build/postcode/codepoint.js` answers
 *   `build postcode-codepoint`. That is the same convention `repo-health`'s `prefix-directories` check enforces —
 *   siblings sharing a hyphen prefix live in a directory named for it — read from the other end, which is why moving
 *   those files is free.
 *
 *   A namespace directory is unaffected: `gazetteer/` holds `build`, `inspect` and `verify`, none of which is
 *   `gazetteer-`something, so `gazetteer` stays a path segment the user types.
 */

/**
 * Every filesystem path a command segment can name, fewest splits first.
 *
 * `postcode-codepoint` answers `["postcode-codepoint"]` and `["postcode", "codepoint"]`; the literal spelling is tried
 * before any directory reading, so a command whose file sits where its name says costs nothing to resolve.
 */
export function commandPathCandidates(segment: string): string[][] {
	const parts = segment.split("-")
	const candidates: string[][] = []

	// One bit per hyphen: keep it, or make it a directory boundary. Ordered by how many boundaries each answer takes,
	// so the literal name comes first and the deepest nesting last.
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
 * Whether `directory` is a prefix directory for a command declaring `name` — the case where the directory is part of
 * the layout rather than part of what the user types.
 *
 * `gazetteer/inspect/fst.tsx` declares `fst`, so `inspect` is a namespace the user types.
 * `gazetteer/build/postcode/codepoint.tsx` declares `postcode-codepoint`, so `postcode` is layout. Nothing but the
 * declared name separates the two.
 */
export function isPrefixDirectory(directory: string, name: string): boolean {
	return name.startsWith(`${directory}-`)
}

const DECLARED_NAME = /\bspec\s*=\s*\{\s*name\s*:\s*["'`]([^"'`]+)["'`]/u

/**
 * The command name a compiled module declares, READ rather than imported.
 *
 * Importing a command module to learn its name runs the module: it pulls Ink, a resolver, sometimes a database handle,
 * and `mw gazetteer build` — which needs nothing but a list of names — stopped answering at all. Reading the text has
 * no side effect and no cost worth measuring. A module whose spec this cannot find falls back to its filename, which is
 * what the name was before any of this.
 */
export function declaredCommandName(source: string, fallback: string): string {
	return DECLARED_NAME.exec(source)?.[1] ?? fallback
}
