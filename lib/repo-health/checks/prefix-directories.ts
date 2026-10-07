/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   A repeated hyphen prefix among a directory's children is a directory hierarchy encoded in names.
 *   `usgov-nppes/` and `usgov-nad/` are US federal register adapters that belong under `usgov/`. This directory boundary
 *   as a directory makes imports, file listings and editor trees show the same hierarchy.
 *
 *   A group contains two or more children that share their first hyphen-delimited segment. A sibling whose full name
 *   is the prefix joins the group. For example, `reliability.ts` belongs beside `reliability-report.ts` as the family's
 *   own module.
 *   The head stays where it is: a file keeps its name beside the new directory, and a directory is already the
 *   destination.
 *
 *   Two conditions determine what counts as a child. A name can represent an interface instead of a layout. A
 *   workspace directory is an npm package name. `packages/neural-weights-en-gb` is published under that
 *   name and appears in the release list, so it cannot join a group. A subdirectory counts only when it contains a
 *   tracked TypeScript file. That distinguishes code families from data directories that mirror external names.
 *   `hf-publish/mailwoman-cjk/` is a Hugging Face repository. `fixtures/.../whosonfirst-data-admin-fr/` is an upstream
 *   repository. This check does not arrange either external repository.
 */

import { readWorkspaceDirectories } from "@mailwoman/core/workspaces"

import { DiagnosticSeverity, type RepoCheck } from "#repo-health/check"
import type { RepoFix } from "#repo-health/fix"
import type { ModuleMove } from "#repo-health/move/types"

const CHECK_ID = "prefix-directories"

/**
 * How many children must share a prefix before it is a family.
 */
const GROUP_THRESHOLD = 2

const PREFIXED = /^(?<prefix>[a-z0-9]+)-.+$/u
const SOURCE_FILE = /\.tsx?$/u
const TEST_FILE = /\.(?:test|spec)\.tsx?$/u

// The root package exposes these as separate modules through its imports and exports maps.
const ROOT_MODULE_DIRECTORIES = ["lib/release-kit", "lib/release-mcp"] as const

interface PrefixMember {
	/**
	 * The child as written: a file name with its extension, or a directory name.
	 */
	name: string
	kind: "file" | "directory"
	/**
	 * Repo-relative path of the child.
	 */
	path: string
	/**
	 * For a directory, the sibling module that takes its name (`x.ts` beside `x/`).
	 * It moves with the directory.
	 */
	companion?: string
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
 * A directory child qualifies when it contains a tracked TypeScript file.
 * Workspace directories never qualify.
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

	return new Map([...children].map(([directory, bucket]) => [directory, withCompanions([...bucket.values()])]))
}

function memberStem(member: PrefixMember): string {
	return member.kind === "file" ? member.name.replace(SOURCE_FILE, "") : member.name
}

/**
 * Folds each module that takes a sibling directory's name into that directory's member.
 *
 * `x.ts` beside `x/` is the directory's own module rather than a second sibling,
 * so the pair counts once toward a prefix group and moves as one.
 */
function withCompanions(members: readonly PrefixMember[]): PrefixMember[] {
	const directories = new Set(members.filter((member) => member.kind === "directory").map((member) => member.name))

	return members.flatMap((member) => {
		if (member.kind === "file") return directories.has(memberStem(member)) ? [] : [member]

		const companion = members.find((sibling) => sibling.kind === "file" && memberStem(sibling) === member.name)

		return [companion ? { ...member, companion: companion.path } : member]
	})
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

		// A sibling whose full name is the prefix belongs to the family it heads:
		// `reliability.ts` beside `reliability-report.ts` is the family's own module.
		// Its omission splits the family across two levels.
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
 * Lists the moves a group needs.
 *
 * The shared prefix becomes the directory.
 * Each member keeps the rest of its name.
 *
 * A directory member expands into one move per tracked file beneath it,
 * because the move operation works in files.
 * That is what lets it repoint the specifiers naming each one.
 */
export function planPrefixMoves(groups: readonly PrefixGroup[], trackedFiles: readonly string[]): ModuleMove[] {
	const moves: ModuleMove[] = []

	// A directory that is itself moving includes its contents, so a group inside one
	// would claim the same file twice with two destinations.
	// `lib/cli-native/command-router.ts` is both a `cli-` member through its directory
	// and a `command-` member in its own right.
	// The outer move wins this pass and the check re-reads afterwards.
	// That is what the fix's repeated passes are for.
	const movingDirectories = groups.flatMap((group) =>
		group.members.filter((member) => member.kind === "directory" && member.name !== group.prefix).map((m) => m.path)
	)

	for (const group of groups) {
		if (movingDirectories.some((moving) => group.directory.startsWith(`${moving}/`) || group.directory === moving)) {
			continue
		}

		for (const member of group.members) {
			const stem = member.kind === "file" ? member.name.replace(SOURCE_FILE, "") : member.name

			// The member whose full name is the prefix heads the family and stays put.
			// A head file sits beside the new directory, so `reliability.ts` keeps its
			// specifier and no `index` is created.
			if (stem === group.prefix) continue

			const rest = member.name.slice(group.prefix.length + 1)
			const destination = `${group.directory}/${group.prefix}/${rest}`

			if (member.kind === "file") {
				moves.push({ from: member.path, to: destination })

				continue
			}

			for (const file of trackedFiles) {
				if (!file.startsWith(`${member.path}/`)) continue

				moves.push({ from: file, to: `${destination}${file.slice(member.path.length)}` })
			}

			if (member.companion) {
				moves.push({ from: member.companion, to: `${destination}${member.companion.slice(member.path.length)}` })
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

		return findPrefixGroups(context.trackedFiles, [...workspaceDirectories, ...ROOT_MODULE_DIRECTORIES]).map(
			(group) => ({
				severity: DiagnosticSeverity.Error,
				file: group.members[0]!.path,
				message: `${group.members.length} siblings in ${group.directory}/ share the "${group.prefix}-" prefix (${describe(group)}). Move them under ${group.directory}/${group.prefix}/ — \`mwops health fix ${CHECK_ID}\` does it.`,
				line: null,
				details: null,
			})
		)
	},
}

/**
 * Repairs {@linkcode prefixDirectoriesCheck} findings.
 *
 * Each grouped sibling moves into its prefix directory.
 * The move operation updates references to the file.
 */
export const prefixDirectoriesFix: RepoFix = {
	id: CHECK_ID,
	description: "Move each repeated-prefix sibling into a directory named for the prefix.",
	async plan(context) {
		const workspaceDirectories = await readWorkspaceDirectories(context.repoRoot)

		return {
			moves: planPrefixMoves(
				findPrefixGroups(context.trackedFiles, [...workspaceDirectories, ...ROOT_MODULE_DIRECTORIES]),
				context.trackedFiles
			),
		}
	},
}
