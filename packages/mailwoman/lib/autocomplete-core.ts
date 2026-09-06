/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Framework-free FST autocomplete shared by CLI and library-facing adapters.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { readLocalBuffer, pathExists } from "@mailwoman/core/fs/readers"
import { CommandError } from "@mailwoman/core/scripting/command"
import type { PathBuilderLike } from "path-ts"

import { $public } from "#env"

/**
 * Resolve the FST artifact from an explicit flag, environment, or the application data directory.
 *
 * The filename is LOWERCASE on both halves of the locale tag, because that is what the builder writes
 * (`gazetteer-pipeline/fst.ts`'s artifact list). A `fst-en-US.bin` default resolves to nothing on every machine, and
 * the command reports it as a missing artifact rather than as a name it got wrong.
 */
export function resolveFSTPath(explicitPath?: string): PathBuilderLike {
	return explicitPath ?? $public.MAILWOMAN_FST_BIN ?? dataRootPath("wof", "fst-per-locale", "fst-en-us.bin")
}

/**
 * One ranked FST completion.
 */
export interface AutocompleteEntry {
	name: string
	placetype: string
	wofID: number
	referential: number
	encyclopedic?: number
	completionTokens: string[]
}

/**
 * Load an FST artifact and return ranked prefix completions.
 */
export async function runAutocomplete(
	prefix: string,
	opts: { fstPath: PathBuilderLike; limit?: number }
): Promise<AutocompleteEntry[]> {
	if (!(await pathExists(opts.fstPath))) {
		throw new CommandError(
			`FST binary not found at ${opts.fstPath}.\n` +
				"Pass --fst <path>, set $MAILWOMAN_FST_BIN, or build it with `mailwoman gazetteer build fst`."
		)
	}

	let buffer: Buffer

	try {
		buffer = await readLocalBuffer(opts.fstPath)
	} catch (error) {
		throw new CommandError(`Failed to read FST binary at ${opts.fstPath}`, { cause: error })
	}

	const [{ deserializeFST }, { autocomplete }] = await Promise.all([
		import("@mailwoman/resolver-wof-sqlite/fst"),
		import("@mailwoman/resolver-wof-sqlite/fst"),
	])

	let matcher

	try {
		matcher = deserializeFST(buffer)
	} catch (error) {
		throw new CommandError(`Malformed FST binary at ${opts.fstPath}`, { cause: error })
	}

	return autocomplete(matcher, prefix, { maxSuggestions: opts.limit ?? 10 }).suggestions.map((suggestion) => ({
		name: suggestion.name,
		placetype: suggestion.placetype,
		wofID: suggestion.wofID,
		referential: suggestion.referential,
		...(suggestion.encyclopedic === undefined ? {} : { encyclopedic: suggestion.encyclopedic }),
		completionTokens: suggestion.completionTokens,
	}))
}

/**
 * Render ranked completions for a terminal.
 */
export function formatAutocomplete(entries: readonly AutocompleteEntry[]): string {
	if (!entries.length) return "(no completions)"

	return entries
		.map((entry, index) => {
			const completion = entry.completionTokens.length ? ` [+${entry.completionTokens.join(" ")}]` : ""
			const encyclopedic = entry.encyclopedic === undefined ? "" : `, enc:${entry.encyclopedic.toFixed(4)}`

			return `${String(index + 1).padStart(2)}. ${entry.name}${completion}  (${entry.placetype}, wof:${entry.wofID}, ref:${entry.referential.toFixed(4)}${encyclopedic})`
		})
		.join("\n")
}
