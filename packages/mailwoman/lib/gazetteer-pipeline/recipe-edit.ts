/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Add or remove a country in one of `defaults.ts`'s coverage lists, as a text transformation.
 *
 *   WHY TEXT AND NOT AN AST REWRITE. The lists are `as const` string arrays whose VALUE a codemod could
 *   reproduce exactly and whose COMMENTS it would not. The `IN` entry is five lines recording 189,026
 *   sub-locality nodes at 98.6% conversion, six times the shipped GB pair index, and the instruction to
 *   remove IN from the Overture list in the same change. That prose is the reason the entry is defensible,
 *   and #1015 is what happens when the recipe stops being reviewed like code.
 *
 *   WHY IT REFUSES RATHER THAN GUESSES. Adding is mechanical: a new entry has no prose yet, and sorted
 *   insertion is unambiguous. Removing is not — an entry with a comment block above it cannot be deleted
 *   without deciding what becomes of the measurement, and no rule this module could carry would decide
 *   that correctly. So a commented removal is REFUSED with the lines quoted, and a person moves them.
 *
 *   Nothing here writes to disk. The caller gets the new source and decides whether to apply it, which is
 *   what keeps an irreversible-looking step reviewable as a diff.
 */

/**
 * A refusal, or the rewritten source.
 */
export type RecipeEditResult =
	| { ok: true; source: string; changed: boolean; note: string }
	| { ok: false; reason: string; comment?: string[] }

/**
 * Locate a list's entries by name.
 *
 * Returns the source offsets of the array body so a caller can splice inside it without touching anything else in the
 * file — including the docstring above the list, which every one of them carries.
 */
function listBody(source: string, listName: string): { start: number; end: number } | undefined {
	const header = new RegExp(`export const ${listName}\\s*=\\s*\\[`, "u").exec(source)

	if (!header) return undefined

	const start = header.index + header[0].length
	const end = source.indexOf("]", start)

	return end === -1 ? undefined : { start, end }
}

/**
 * The lines of a list body, with their indentation preserved.
 */
function bodyLines(body: string): string[] {
	// oxlint-disable-next-line mailwoman/prefer-spliterator -- a bounded TypeScript list body is intentionally indexed and rewritten in memory
	return body.split("\n")
}

/**
 * Comment lines immediately above `index`, walking upward until a non-comment line.
 *
 * Blank lines stop the walk: a comment separated from an entry by a blank line belongs to the list, not to the entry,
 * and treating it as attached would refuse removals that are perfectly safe.
 */
function attachedComment(lines: readonly string[], index: number): string[] {
	const out: string[] = []

	for (let i = index - 1; i >= 0; i--) {
		const trimmed = lines[i]!.trim()

		if (trimmed.startsWith("//")) {
			out.unshift(lines[i]!)

			continue
		}

		break
	}

	return out
}

const entryPattern = (country: string): RegExp => new RegExp(`^\\s*"${country}",?\\s*$`, "u")

/**
 * Add a country to a list, in sorted position.
 *
 * Sorted rather than appended because every list is sorted today, and an appended entry reads as an afterthought in a
 * file whose whole purpose is to be reviewed. Adding a country that is already present is a NO-OP reported as such, not
 * an error: a caller running the same plan twice should get the same tree.
 */
export function addCountry(source: string, listName: string, country: string): RecipeEditResult {
	const cc = country.toUpperCase()
	const body = listBody(source, listName)

	if (!body) return { ok: false, reason: `No list named ${listName} in defaults.ts` }

	const inner = source.slice(body.start, body.end)
	const lines = bodyLines(inner)

	if (lines.some((line) => entryPattern(cc).test(line))) {
		return { ok: true, source, changed: false, note: `${cc} is already in ${listName}` }
	}

	// The first entry that sorts after the new one. Comment lines are skipped as sort keys but stay attached to
	// whatever follows them, so inserting BEFORE a comment block would separate it from its entry.
	let insertAt = lines.length

	for (const [i, line] of lines.entries()) {
		const match = /^\s*"([A-Z]{2})",?\s*$/u.exec(line)

		if (!match) continue

		if (match[1]! > cc) {
			const comment = attachedComment(lines, i)

			insertAt = i - comment.length

			break
		}
	}

	const indent = lines.find((line) => /^\s*"[A-Z]{2}"/u.test(line))?.match(/^\s*/u)?.[0] ?? "\t"
	const next = [...lines.slice(0, insertAt), `${indent}"${cc}",`, ...lines.slice(insertAt)]

	return {
		ok: true,
		source: source.slice(0, body.start) + next.join("\n") + source.slice(body.end),
		changed: true,
		note: `added ${cc} to ${listName}`,
	}
}

/**
 * Remove a country from a list, or refuse when prose would be orphaned.
 */
export function removeCountry(source: string, listName: string, country: string): RecipeEditResult {
	const cc = country.toUpperCase()
	const body = listBody(source, listName)

	if (!body) return { ok: false, reason: `No list named ${listName} in defaults.ts` }

	const inner = source.slice(body.start, body.end)
	const lines = bodyLines(inner)
	const index = lines.findIndex((line) => entryPattern(cc).test(line))

	if (index === -1) return { ok: true, source, changed: false, note: `${cc} is not in ${listName}` }

	const comment = attachedComment(lines, index)

	if (comment.length) {
		return {
			ok: false,
			reason:
				`${cc} carries ${comment.length} line(s) of prose in ${listName}, and removing the entry would orphan ` +
				"them. That prose is why the entry is defensible — move it deliberately, then re-run.",
			comment,
		}
	}

	const next = [...lines.slice(0, index), ...lines.slice(index + 1)]

	return {
		ok: true,
		source: source.slice(0, body.start) + next.join("\n") + source.slice(body.end),
		changed: true,
		note: `removed ${cc} from ${listName}`,
	}
}
