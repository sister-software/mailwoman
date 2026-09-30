/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   A module below a package's `lib/` is named for what it holds, so `lib/<dir>/index.ts` sits beside its directory as
 *   `lib/<dir>.ts`. The source roots beside `lib/` (`sdk/`, `tools/`, `cli/`) follow the same rule. The `"./*"` export pattern resolves `<package>/<dir>` to that file, which keeps the specifier a
 *   directory index used to provide. The package root `lib/index.ts` is the one index a package keeps.
 *
 *   A test of the index moves with it, so `lib/<dir>/index.test.ts` and `lib/<dir>/<dir>.test.ts` become
 *   `lib/<dir>.test.ts` and stay beside their module.
 *
 *   A file-routed tree reverses the rule. The `mailwoman` CLI router reads `commands/<group>/index.js` as the command
 *   of a group that also has subcommands, so inside that tree a group's own module is `<group>/index.tsx`, and a
 *   `<group>.tsx` beside `<group>/` is reported instead.
 */

import { DiagnosticSeverity, type RepoCheck } from "#check"
import type { RepoFix } from "#fix"
import type { ModuleMove } from "#move/types"

const CHECK_ID = "nested-index"

const NESTED_INDEX = /^(?<directory>packages\/[^/]+\/(?:lib|sdk|tools|cli)\/.+)\/index(?<suffix>(?:\.[a-z]+)*\.tsx?)$/u
const TEST_SUFFIX = /^(?:\.[a-z]+)*\.test\.tsx?$/u
const MODULE_SUFFIX = /^(?:\.[a-z]+)*\.tsx?$/u

/**
 * Directories whose router gives the name `index` a meaning, so index modules there stay.
 */
const ROUTED_TREES: readonly string[] = ["packages/mailwoman/cli/commands/"]

const insideRoutedTree = (path: string): boolean => ROUTED_TREES.some((tree) => path.startsWith(tree))

interface NestedIndex {
	directory: string
	/**
	 * Every tracked file named `index.<suffix>` in the directory: the module and the tests beside it.
	 */
	files: Array<{ path: string; suffix: string }>
	/**
	 * The module's destination when a tracked file already occupies it.
	 */
	collision?: string
}

/**
 * A group module in a routed tree that sits beside its directory instead of inside it as `index`.
 */
interface MisplacedGroupModule {
	directory: string
	files: Array<{ path: string; suffix: string }>
}

/**
 * Every directory below a package's `lib/` holding an index module, with the files that move alongside it.
 * Routed trees are skipped.
 */
export function findNestedIndexes(trackedFiles: readonly string[]): NestedIndex[] {
	const tracked = new Set(trackedFiles)
	const byDirectory = new Map<string, NestedIndex>()

	for (const path of trackedFiles) {
		if (insideRoutedTree(path)) continue

		const groups = NESTED_INDEX.exec(path)?.groups

		if (!groups) continue

		const directory = groups["directory"]!
		const suffix = groups["suffix"]!
		const entry = byDirectory.get(directory) ?? { directory, files: [] }

		entry.files.push({ path, suffix })
		byDirectory.set(directory, entry)
	}

	const indexes: NestedIndex[] = []

	for (const entry of byDirectory.values()) {
		// A directory holding only index tests has no module to rename, so it is not reported here.
		if (entry.files.every((file) => TEST_SUFFIX.test(file.suffix))) continue

		// A test named for the directory covers the index when no module of that name sits beside it.
		const basename = entry.directory.slice(entry.directory.lastIndexOf("/") + 1)

		for (const path of trackedFiles) {
			if (!path.startsWith(`${entry.directory}/${basename}.`)) continue

			const suffix = path.slice(entry.directory.length + 1 + basename.length)

			if (!TEST_SUFFIX.test(suffix)) continue

			if (tracked.has(`${entry.directory}/${basename}.ts`) || tracked.has(`${entry.directory}/${basename}.tsx`))
				continue

			entry.files.push({ path, suffix })
		}

		const collision = entry.files.map((file) => `${entry.directory}${file.suffix}`).find((path) => tracked.has(path))

		indexes.push(collision ? { ...entry, collision } : entry)
	}

	return indexes.toSorted((a, b) => a.directory.localeCompare(b.directory))
}

/**
 * Every group module in a routed tree that sits beside its directory, with its tests.
 *
 * A group whose directory already holds an index module is left alone.
 */
export function findMisplacedGroupModules(trackedFiles: readonly string[]): MisplacedGroupModule[] {
	const directories = new Set<string>()

	for (const path of trackedFiles) {
		if (!insideRoutedTree(path)) continue

		for (let slash = path.indexOf("/"); slash !== -1; slash = path.indexOf("/", slash + 1)) {
			directories.add(path.slice(0, slash))
		}
	}

	const byDirectory = new Map<string, MisplacedGroupModule>()

	for (const path of trackedFiles) {
		if (!insideRoutedTree(path)) continue

		const dot = path.indexOf(".", path.lastIndexOf("/"))
		const directory = path.slice(0, dot)
		const suffix = path.slice(dot)

		if (!directories.has(directory) || !MODULE_SUFFIX.test(suffix)) continue

		const entry = byDirectory.get(directory) ?? { directory, files: [] }

		entry.files.push({ path, suffix })
		byDirectory.set(directory, entry)
	}

	const hasIndex = (directory: string): boolean =>
		trackedFiles.some(
			(path) => path.startsWith(`${directory}/index.`) && !TEST_SUFFIX.test(path.slice(directory.length + 6))
		)

	return [...byDirectory.values()]
		.filter((entry) => entry.files.some((file) => !TEST_SUFFIX.test(file.suffix)) && !hasIndex(entry.directory))
		.toSorted((a, b) => a.directory.localeCompare(b.directory))
}

/**
 * The moves that rename each index module and its tests to sit beside their directory,
 * and each misplaced group module back into its directory as `index`.
 *
 * A directory whose destination is taken is left for a person to name.
 */
export function planNestedIndexMoves(
	indexes: readonly NestedIndex[],
	misplaced: readonly MisplacedGroupModule[] = []
): ModuleMove[] {
	return [
		...indexes
			.filter((entry) => !entry.collision)
			.flatMap((entry) => entry.files.map((file) => ({ from: file.path, to: `${entry.directory}${file.suffix}` }))),
		...misplaced.flatMap((entry) =>
			entry.files.map((file) => ({ from: file.path, to: `${entry.directory}/index${file.suffix}` }))
		),
	]
}

/**
 * The `nested-index` check: an error for each index module below a package's `lib/` other than
 * `lib/index.ts`, and for each group module in a routed tree that sits outside its directory.
 */
export const nestedIndexCheck: RepoCheck = {
	id: CHECK_ID,
	description: "A module below lib/ is named for its directory (lib/<dir>.ts) rather than lib/<dir>/index.ts.",
	async run(context) {
		const indexes = findNestedIndexes(context.trackedFiles).map((entry) => {
			const module = entry.files.find((file) => !TEST_SUFFIX.test(file.suffix))!

			return {
				severity: DiagnosticSeverity.Error,
				file: module.path,
				message: entry.collision
					? `${module.path} is an index module, and ${entry.collision} already exists. Rename one of them by hand.`
					: `${module.path} is an index module. Rename it ${entry.directory}${module.suffix} — \`mwops health fix ${CHECK_ID}\` does it.`,
			}
		})

		const misplaced = findMisplacedGroupModules(context.trackedFiles).map((entry) => {
			const module = entry.files.find((file) => !TEST_SUFFIX.test(file.suffix))!

			return {
				severity: DiagnosticSeverity.Error,
				file: module.path,
				message: `${module.path} is a routed group's command, which the router reads only as ${entry.directory}/index${module.suffix}. \`mwops health fix ${CHECK_ID}\` moves it.`,
			}
		})

		return [...indexes, ...misplaced]
	},
}

/**
 * Repairs {@linkcode nestedIndexCheck} findings that have a free destination.
 */
export const nestedIndexFix: RepoFix = {
	id: CHECK_ID,
	description: "Rename each nested index module to sit beside its directory, except in a routed tree.",
	async plan(context) {
		return {
			moves: planNestedIndexMoves(
				findNestedIndexes(context.trackedFiles),
				findMisplacedGroupModules(context.trackedFiles)
			),
		}
	},
}
