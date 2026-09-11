/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   A repeated hyphen prefix among a directory's children is a directory hierarchy encoded in names.
 *   `usgov-nppes/` and `usgov-nad/` do not merely happen to start alike: they are US federal register adapters and
 *   belong under `usgov/`. Keeping that boundary as a directory lets imports, a file listing, and an editor's tree
 *   state the same hierarchy.
 *
 *   A group is two or more children sharing their first hyphen-delimited segment, and the sibling named for the prefix
 *   itself joins them: `reliability.ts` beside `reliability-report.ts` is the family's own module, not a bystander.
 *   A file in that position becomes the directory's `index`; a directory in it is already the destination and stays.
 *
 *   Two conditions decide what counts as a child, and both exist because a NAME is sometimes a contract rather than a
 *   layout. A workspace directory is an npm package name — `packages/neural-weights-en-gb` is published under that
 *   name and named by the release list — so it is never a group member. And a subdirectory counts only when it holds
 *   at least one tracked TypeScript file, which is what separates a code family from a data directory mirroring
 *   someone else's names: `hf-publish/mailwoman-cjk/` is a Hugging Face repository and
 *   `fixtures/.../whosonfirst-data-admin-fr/` is an upstream repository, and neither is this repository's to arrange.
 */

import { readWorkspaceDirectories } from "@mailwoman/core/workspaces"

import { DiagnosticSeverity, type RepoCheck } from "#check"
import type { RepoFix } from "#fix"
import type { ModuleMove } from "#move/types"

const CHECK_ID = "prefix-directories"

/**
 * How many children must share a prefix before it is a family.
 */
const GROUP_THRESHOLD = 2

const PREFIXED = /^(?<prefix>[a-z0-9]+)-.+$/u
const SOURCE_FILE = /\.tsx?$/u
const TEST_FILE = /\.(?:test|spec)\.tsx?$/u

export interface PrefixMember {
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

export interface PrefixGroup {
	/**
	 * The parent holding the group, repo-relative and without a trailing slash.
	 */
	directory: string
	prefix: string
	members: PrefixMember[]
}

function isSource(file: string): boolean {
	return SOURCE_FILE.test(file) && !TEST_FILE.test(file) && !file.endsWith(".d.ts") && !file.includes("/out/")
}

/**
 * Every directory-with-children view of the tracked tree, as `name -> kind` per parent directory.
 *
 * A directory child is admitted only when it carries a tracked TypeScript file somewhere beneath it, and a workspace
 * directory is never admitted at all.
 */
function directoryChildren(
	trackedFiles: readonly string[],
	workspaceDirectories: ReadonlySet<string>
): Map<string, PrefixMember[]> {
	const carriesSource = new Set<string>()

	for (const file of trackedFiles) {
		if (!isSource(file)) continue

		const segments = file.split("/")

		for (let depth = 1; depth <= segments.length; depth++) {
			carriesSource.add(segments.slice(0, depth).join("/"))
		}
	}

	const children = new Map<string, Map<string, PrefixMember>>()

	for (const file of trackedFiles) {
		if (file.includes("/out/") || file.includes("node_modules/")) continue

		const segments = file.split("/")

		for (let depth = 1; depth < segments.length; depth++) {
			const directory = segments.slice(0, depth).join("/")
			const name = segments[depth]!
			const path = `${directory}/${name}`
			const kind = depth === segments.length - 1 ? "file" : "directory"

			if (kind === "file" && !isSource(path)) continue

			if (kind === "directory" && !carriesSource.has(path)) continue

			if (workspaceDirectories.has(path)) continue

			const bucket = children.get(directory) ?? new Map<string, PrefixMember>()

			bucket.set(name, { name, kind, path })
			children.set(directory, bucket)
		}
	}

	return new Map([...children].map(([directory, bucket]) => [directory, [...bucket.values()]]))
}

/**
 * Every repeated-prefix group in the tracked tree, sorted for a stable diagnostic order.
 */
export function findPrefixGroups(
	trackedFiles: readonly string[],
	workspaceDirectories: readonly string[] = []
): PrefixGroup[] {
	const workspaces = new Set(workspaceDirectories)
	const groups: PrefixGroup[] = []

	for (const [directory, members] of directoryChildren(trackedFiles, workspaces)) {
		const byPrefix = new Map<string, PrefixMember[]>()

		const stems = new Map<string, PrefixMember>()

		for (const member of members) {
			const stem = member.kind === "file" ? member.name.replace(SOURCE_FILE, "") : member.name

			stems.set(stem, member)

			const prefix = PREFIXED.exec(stem)?.groups?.prefix

			if (!prefix) continue

			byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), member])
		}

		// A sibling named for the prefix itself belongs to the family it heads: `reliability.ts` beside
		// `reliability-report.ts` is the family's own module, and leaving it out splits the family across two levels.
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
 * The moves a group needs: the shared prefix becomes the directory, and each member keeps the rest of its name.
 *
 * A directory member expands into one move per tracked file beneath it, because the move operation works in files —
 * that is what lets it repoint the specifiers naming each one.
 */
export function planPrefixMoves(groups: readonly PrefixGroup[], trackedFiles: readonly string[]): ModuleMove[] {
	const moves: ModuleMove[] = []

	// A directory that is itself moving carries its contents with it, so a group INSIDE one would claim the same file
	// twice with two destinations — `lib/cli-native/command-router.ts` is both a `cli-` member through its directory
	// and a `command-` member in its own right. The outer move wins this pass and the check re-reads afterwards; that
	// is what the fix's repeated passes are for.
	const movingDirectories = groups.flatMap((group) =>
		group.members.filter((member) => member.kind === "directory" && member.name !== group.prefix).map((m) => m.path)
	)

	for (const group of groups) {
		if (movingDirectories.some((moving) => group.directory.startsWith(`${moving}/`) || group.directory === moving)) {
			continue
		}

		for (const member of group.members) {
			const stem = member.kind === "file" ? member.name.replace(SOURCE_FILE, "") : member.name
			// The member named for the prefix heads the family rather than sitting beside it. A directory already IS
			// the destination and stays put; a file becomes the directory's index, which is the one name that reads as
			// "the family itself" from inside it.
			const head = stem === group.prefix

			if (head && member.kind === "directory") continue

			const rest = head ? `index${member.name.slice(stem.length)}` : member.name.slice(group.prefix.length + 1)
			const destination = `${group.directory}/${group.prefix}/${rest}`

			if (member.kind === "file") {
				moves.push({ from: member.path, to: destination })

				continue
			}

			for (const file of trackedFiles) {
				if (!file.startsWith(`${member.path}/`)) continue

				moves.push({ from: file, to: `${destination}${file.slice(member.path.length)}` })
			}
		}
	}

	return moves
}

/**
 * A group's members as a diagnostic reads them, directories marked with a trailing slash.
 */
function describe(group: PrefixGroup): string {
	return group.members.map((member) => (member.kind === "directory" ? `${member.name}/` : member.name)).join(", ")
}

/**
 * Enforces that a family of three or more siblings sharing a hyphen prefix has a real directory.
 */
export const prefixDirectoriesCheck: RepoCheck = {
	id: CHECK_ID,
	description: "Three or more siblings sharing a hyphen-delimited prefix live under a directory named for it.",
	async run(context) {
		const workspaceDirectories = await readWorkspaceDirectories(context.repoRoot)

		return findPrefixGroups(context.trackedFiles, workspaceDirectories).map((group) => ({
			severity: DiagnosticSeverity.Error,
			file: group.members[0]!.path,
			message: `${group.members.length} siblings in ${group.directory}/ share the "${group.prefix}-" prefix (${describe(group)}). Move them under ${group.directory}/${group.prefix}/ — \`mwops health fix ${CHECK_ID}\` does it.`,
		}))
	},
}

/**
 * The repair for {@linkcode prefixDirectoriesCheck}: every grouped sibling moves into its prefix directory, and the move
 * operation repoints whatever named it.
 */
export const prefixDirectoriesFix: RepoFix = {
	id: CHECK_ID,
	description: "Move each repeated-prefix sibling into a directory named for the prefix.",
	async plan(context) {
		const workspaceDirectories = await readWorkspaceDirectories(context.repoRoot)

		return planPrefixMoves(findPrefixGroups(context.trackedFiles, workspaceDirectories), context.trackedFiles)
	},
}
