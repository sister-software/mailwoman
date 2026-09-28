/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `prefix-directories.ts` for the Python tree: a repeated underscore prefix among a directory's children
 *   encodes hierarchy in names. Keeping that boundary as a directory lets imports and file listings
 *   show the same structure as the editor tree.
 *
 *   The rule matches the TypeScript check and uses `_` as its delimiter instead of `-`.
 *   It needs no workspace exclusion because no Python directory carries a published npm-name interface.
 *   It also skips `__init__.py` and `__main__.py`, which Python reserves as module names.
 *
 *   Scoped to `corpus-python/`, the one Python tree in the repository. The check reports rather than fixes, because
 *   the TypeScript fix's value is repointing import specifiers and this repository has no equivalent mover for
 *   Python.
 */

import { DiagnosticSeverity, type RepoCheck } from "#check"

const CHECK_ID = "python-prefix-directories"

/**
 * The Python tree.
 * A path outside it is not this check's business.
 */
const PYTHON_ROOT = "corpus-python/"

/**
 * How many children must share a prefix before it is a family.
 *
 * Two siblings are a coincidence often enough that the TypeScript check uses the same floor.
 */
const GROUP_THRESHOLD = 3

const PREFIXED = /^(?<prefix>[a-z0-9]+)_.+$/u
const SOURCE_FILE = /\.py$/u

/**
 * Python chooses these names.
 *
 * Readers do not choose them.
 * This check leaves them in place.
 */
const RESERVED = new Set(["__init__.py", "__main__.py"])

/**
 * Prefixes that are a discovery interface rather than a hierarchy.
 *
 * Pytest collects `test_*.py` by default, so grouping them would report every test directory
 * and propose a `test/` subdirectory pytest would have to be retaught to find.
 */
const RESERVED_PREFIXES = new Set(["test"])

export interface PythonPrefixMember {
	/**
	 * The child as written: a file name with its extension, or a directory name.
	 */
	name: string
	kind: "file" | "directory"
	/**
	 * Repo-relative path of the child.
	 */
	path: string
}

export interface PythonPrefixGroup {
	/**
	 * The parent holding the group, repo-relative and without a trailing slash.
	 */
	directory: string
	prefix: string
	members: PythonPrefixMember[]
}

function isSource(file: string): boolean {
	const name = file.slice(file.lastIndexOf("/") + 1)

	return SOURCE_FILE.test(file) && !RESERVED.has(name)
}

/**
 * Every directory-with-children view of the Python tree as one member list per parent directory,
 * admitting a directory child only when it carries a tracked `.py` file beneath it
 * so a data directory mirroring someone else's names stays out.
 */
function directoryChildren(trackedFiles: readonly string[]): Map<string, PythonPrefixMember[]> {
	const pythonFiles = trackedFiles.filter((file) => file.startsWith(PYTHON_ROOT) && !file.includes("/.venv/"))
	const carriesSource = new Set<string>()

	for (const file of pythonFiles) {
		if (!isSource(file)) continue

		const segments = file.split("/")

		for (let depth = 1; depth <= segments.length; depth++) {
			carriesSource.add(segments.slice(0, depth).join("/"))
		}
	}

	const children = new Map<string, Map<string, PythonPrefixMember>>()

	for (const file of pythonFiles) {
		const segments = file.split("/")

		for (let depth = 1; depth < segments.length; depth++) {
			const directory = segments.slice(0, depth).join("/")
			const name = segments[depth]!
			const path = `${directory}/${name}`
			const kind = depth === segments.length - 1 ? "file" : "directory"

			if (kind === "file" && !isSource(path)) continue

			if (kind === "directory" && !carriesSource.has(path)) continue

			const bucket = children.get(directory) ?? new Map<string, PythonPrefixMember>()

			bucket.set(name, { name, kind, path })
			children.set(directory, bucket)
		}
	}

	return new Map([...children].map(([directory, bucket]) => [directory, [...bucket.values()]]))
}

/**
 * Every repeated-prefix group in the Python tree, sorted for a stable diagnostic order.
 */
export function findPythonPrefixGroups(trackedFiles: readonly string[]): PythonPrefixGroup[] {
	const groups: PythonPrefixGroup[] = []

	for (const [directory, members] of directoryChildren(trackedFiles)) {
		const byPrefix = new Map<string, PythonPrefixMember[]>()
		const stems = new Map<string, PythonPrefixMember>()

		for (const member of members) {
			const stem = member.kind === "file" ? member.name.replace(SOURCE_FILE, "") : member.name

			stems.set(stem, member)

			const prefix = PREFIXED.exec(stem)?.groups?.prefix

			if (!prefix || RESERVED_PREFIXES.has(prefix)) continue

			byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), member])
		}

		// A sibling whose full name is the prefix heads the family rather than sitting beside it,
		// since leaving `splice.py` out splits the family across two levels.
		for (const [prefix, grouped] of byPrefix) {
			const head = stems.get(prefix)

			if (head) {
				grouped.unshift(head)
			}
		}

		for (const [prefix, grouped] of byPrefix) {
			if (grouped.length < GROUP_THRESHOLD) continue

			groups.push({
				directory,
				prefix,
				members: grouped.toSorted((a, b) => a.name.localeCompare(b.name)),
			})
		}
	}

	return groups.toSorted((a, b) => a.directory.localeCompare(b.directory) || a.prefix.localeCompare(b.prefix))
}

/**
 * A group's members as a diagnostic reads them, directories marked with a trailing slash.
 */
function describe(group: PythonPrefixGroup): string {
	return group.members.map((member) => (member.kind === "directory" ? `${member.name}/` : member.name)).join(", ")
}

/**
 * Enforces that a family of three or more Python siblings sharing an underscore prefix has a real directory.
 */
export const pythonPrefixDirectoriesCheck: RepoCheck = {
	id: CHECK_ID,
	description:
		"Three or more Python siblings sharing an underscore-delimited prefix live under a directory named for it.",
	run(context) {
		return Promise.resolve(
			findPythonPrefixGroups(context.trackedFiles).map((group) => ({
				severity: DiagnosticSeverity.Error,
				file: group.members[0]!.path,
				message: `${group.members.length} siblings in ${group.directory}/ share the "${group.prefix}_" prefix (${describe(group)}). Move them under ${group.directory}/${group.prefix}/, with the member named for the prefix becoming its \`__init__.py\`.`,
			}))
		)
	},
}
