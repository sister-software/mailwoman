/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   A repeated hyphen prefix in the flat corpus-recipe drawer is a directory hierarchy encoded in
 *   filenames. `fr-admin-split.ts` and `fr-order.ts` do not merely happen to start alike: they are
 *   French recipe modules and belong under `recipes/fr/`. Keeping that boundary as a directory lets
 *   imports, discovery, and a file listing state the same hierarchy.
 *
 *   This check reads tracked files only. It deliberately examines direct children of the recipe
 *   directory, so `recipes/fr/admin-split.ts` is the conforming form and is not re-grouped by its
 *   own filename. A prefix is the first hyphen-delimited filename segment; one such file remains a
 *   flat recipe, while two or more must move together.
 */

import { DiagnosticSeverity, type RepoCheck } from "#check"
import type { RepoFix } from "#fix"
import type { ModuleMove } from "#move/types"

const CHECK_ID = "recipe-prefix-directories"
const RECIPE_DIRECTORY = "packages/corpus/lib/recipes/"
const RECIPE_FILE = /^(?<prefix>[a-z0-9]+)-[^/]+\.ts$/u

export interface RecipePrefixGroup {
	prefix: string
	files: string[]
}

/**
 * Repeated first filename segments among direct recipe-file children, sorted for stable diagnostics.
 */
export function findRepeatedRecipePrefixes(trackedFiles: readonly string[]): RecipePrefixGroup[] {
	const groups = new Map<string, string[]>()

	for (const file of trackedFiles) {
		if (!file.startsWith(RECIPE_DIRECTORY)) continue

		const name = file.slice(RECIPE_DIRECTORY.length)
		const prefix = RECIPE_FILE.exec(name)?.groups?.prefix

		if (!prefix) continue

		const files = groups.get(prefix) ?? []
		files.push(file)
		groups.set(prefix, files)
	}

	return [...groups]
		.filter(([, files]) => files.length >= 2)
		.map(([prefix, files]) => ({ prefix, files: files.toSorted() }))
		.toSorted((a, b) => a.prefix.localeCompare(b.prefix))
}

/**
 * The move each grouped file needs: `recipes/fr-order.ts` becomes `recipes/fr/order.ts`, so the prefix that was carried
 * in the filename is carried by the directory and nothing else changes about the module.
 *
 * The recipe's own `name` is untouched — `fr-fragment.ts` still declares `name: "fr-fragment"` after the move, and it
 * must, because corpus artifacts and eval capability sets are keyed by that string.
 */
export function planRecipePrefixMoves(trackedFiles: readonly string[]): ModuleMove[] {
	return findRepeatedRecipePrefixes(trackedFiles).flatMap(({ prefix, files }) =>
		files.map((file) => ({
			from: file,
			to: `${RECIPE_DIRECTORY}${prefix}/${file.slice(RECIPE_DIRECTORY.length + prefix.length + 1)}`,
		}))
	)
}

/**
 * Enforces that a recipe family has a real directory once more than one module shares its prefix.
 */
export const recipePrefixDirectoriesCheck: RepoCheck = {
	id: CHECK_ID,
	description: "Repeated hyphen-prefixed corpus recipe files live under a directory named for their shared prefix.",
	async run(context) {
		return findRepeatedRecipePrefixes(context.trackedFiles).map(({ prefix, files }) => ({
			severity: DiagnosticSeverity.Error,
			file: files[0],
			message: `${files.length} sibling recipe files share the "${prefix}-" prefix (${files.map((file) => file.slice(RECIPE_DIRECTORY.length)).join(", ")}). Move them under ${RECIPE_DIRECTORY}${prefix}/ — \`mwops health fix ${CHECK_ID}\` does it.`,
		}))
	},
}

/**
 * The repair for {@linkcode recipePrefixDirectoriesCheck}: every grouped file moves into its prefix directory, and the
 * move operation repoints whatever imported it.
 */
export const recipePrefixDirectoriesFix: RepoFix = {
	id: CHECK_ID,
	description: "Move each repeated-prefix recipe file into a directory named for the prefix.",
	async plan(context) {
		return planRecipePrefixMoves(context.trackedFiles)
	},
}
