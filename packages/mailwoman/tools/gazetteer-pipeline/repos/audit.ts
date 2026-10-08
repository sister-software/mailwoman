/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Reports the clones in the WOF repos root. This supplies the other half of `country-plan`.
 *
 *   `country-plan` reads the built artifact to learn what source serves each country. It cannot report files on disk
 *   that await a build. For the WOF leg, `ingestWOF` globs `**\/data\/**\/*.geojson` under the repos root and reads no
 *   list. The directory contents form the recipe. The next build includes any clone, whether or not someone declared
 *   it. A declaration without a clone will produce no coverage.
 *
 *   Two layouts can coexist. A repository present in both can represent two independent checkouts or one checkout
 *   reached through a symlink. The audit distinguishes these cases instead of counting paths. Only independent copies
 *   can diverge. If one copy is pulled and the other remains unchanged, filesystem enumeration order decides which
 *   value is ingested. `verifyAdmin` tests floors and cannot detect that conflict. A symlink alias points to one
 *   physical copy, so it cannot diverge. A risk estimate that combines aliases and separate checkouts would be wrong.
 */

import { entryLeadsToDirectory, pathExists, realPath } from "@mailwoman/core/fs/readers/stat"
import { runFileSync } from "@mailwoman/core/process"
import { type PathBuilder, type PathBuilderLike, resolvePathBuilder } from "path-ts"
import { Globerator } from "spliterator/node/fs"

/**
 * Where a clone sits relative to the repos root.
 */
export const CloneLayout = {
	/**
	 * `<root>/<name>`.
	 */
	Flat: "flat",
	/**
	 * `<root>/<owner>/<name>`, the layout `gazetteer inspect sync` writes.
	 */
	Nested: "nested",
} as const

export type CloneLayout = (typeof CloneLayout)[keyof typeof CloneLayout]

export interface ClonedRepo {
	name: string
	layouts: CloneLayout[]
	/**
	 * True when the layouts resolve to the same directory through a symlink rather than a second checkout.
	 *
	 * The ingest skips the alias.
	 * One physical directory cannot diverge from itself.
	 */
	aliased: boolean
	/**
	 * `head` per layout, so a duplicate can be reported as same-commit or diverged
	 * rather than merely as duplicated.
	 *
	 * Absent for a directory that is not a git checkout.
	 */
	commits: Partial<Record<CloneLayout, string>>
	/**
	 * The ISO-2 country the repo name encodes, or `undefined` for a repo with no
	 * country (`whosonfirst-placetypes`).
	 */
	country?: string
	theme?: string
}

export interface ReposAudit {
	root: PathBuilderLike
	repos: ClonedRepo[]
	/**
	 * Repos present in both layouts as independent checkouts.
	 *
	 * Reported separately because the count is the finding.
	 */
	duplicated: ClonedRepo[]
	/**
	 * Repos reachable through both layouts via a symlink, one physical copy.
	 *
	 * The ingest skips the symlinked layout.
	 * The physical directory cannot diverge like a duplicated checkout in {@link ReposAudit.duplicated}.
	 */
	aliased: ClonedRepo[]
	/**
	 * Duplicated repos whose two copies are at different commits, the state
	 * where the ingest's result depends on enumeration order.
	 *
	 * Empty is the good case and is reported as such.
	 */
	diverged: ClonedRepo[]
}

const REPO_NAME = /^whosonfirst-(?:data|external)-(?<theme>[a-z]+(?:-[a-z]+)*?)-(?<country>[a-z]{2})$/

/**
 * Split a repo name into its theme and country, when it includes one.
 */
export function parseRepoName(name: string): { theme?: string; country?: string } {
	const match = REPO_NAME.exec(name)

	if (!match?.groups) return {}

	return { theme: match.groups["theme"], country: match.groups["country"]?.toUpperCase() }
}

/**
 * `head` for a checkout, or `null` when the directory is not one.
 *
 * A clone without git metadata can be a directory extracted from an archive.
 * The audit reports its vintage as absent and continues checking the root.
 */
function headOf(dir: PathBuilder): string | null {
	try {
		return runFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: dir, encoding: "utf8", stdio: "pipe" }).trim()
	} catch {
		return null
	}
}

/**
 * Walk the repos root and report every clone, its layout(s) and its vintage.
 *
 * The audit examines two levels because repositories use two layouts:
 * directly under the root or under an owner directory.
 * Paths below that level belong to a repo's own contents.
 */
export async function auditReposRoot(
	root: PathBuilderLike,
	options: { readCommits?: boolean } = {}
): Promise<ReposAudit> {
	const byName = new Map<string, ClonedRepo>()

	const realPaths = new Map<string, string[]>()

	const record = async (name: string, layout: CloneLayout, dir: PathBuilder): Promise<void> => {
		const existing = byName.get(name) ?? { name, layouts: [], commits: {}, aliased: false, ...parseRepoName(name) }

		existing.layouts.push(layout)

		// `realpath` is what separates a second checkout from a second path to the first.
		// Directory listings cannot distinguish the cases because both shapes look identical from `ls`.
		try {
			realPaths.set(name, [...(realPaths.get(name) ?? []), await realPath(dir)])
		} catch {
			// Unresolvable (a broken link).
			// Left out of the alias comparison rather than guessed at.
		}

		if (options.readCommits !== false) {
			const head = headOf(dir)

			if (head) {
				existing.commits[layout] = head
			}
		}

		byName.set(name, existing)
	}

	if (!(await pathExists(root))) {
		return {
			root,
			repos: [],
			duplicated: [],
			aliased: [],
			diverged: [],
		}
	}

	for await (const entry of Globerator.from("*", { cwd: root, withFileTypes: true, onlyFiles: false })) {
		const full = resolvePathBuilder(root, entry.name)

		if (!(await entryLeadsToDirectory(entry))) continue

		if (entry.name.startsWith("whosonfirst-data-") || entry.name.startsWith("whosonfirst-external-")) {
			await record(entry.name, CloneLayout.Flat, full)

			continue
		}

		// An owner directory whose children are the nested layout.
		// A name that is itself a repo was handled above.
		for await (const child of Globerator.from("*", { cwd: full, withFileTypes: true, onlyFiles: false })) {
			const childPath = full(child.name)

			if (child.name.startsWith("whosonfirst-") && (await entryLeadsToDirectory(child))) {
				await record(child.name, CloneLayout.Nested, childPath)
			}
		}
	}

	for (const [name, paths] of realPaths) {
		const repo = byName.get(name)

		if (repo && paths.length > 1 && new Set(paths).size === 1) {
			repo.aliased = true
		}
	}

	const repos = [...byName.values()].toSorted((a, b) => a.name.localeCompare(b.name))
	const multiPath = repos.filter((repo) => repo.layouts.length > 1)
	const duplicated = multiPath.filter((repo) => !repo.aliased)

	return {
		root,
		repos,
		duplicated,
		aliased: multiPath.filter((repo) => repo.aliased),
		diverged: duplicated.filter((repo) => {
			const commits = Object.values(repo.commits)

			return commits.length > 1 && new Set(commits).size > 1
		}),
	}
}

/**
 * Which countries the repos root would contribute to a build, regardless of any list.
 */
export function clonedCountries(audit: ReposAudit): string[] {
	return [...new Set(audit.repos.flatMap((repo) => (repo.country ? [repo.country] : [])))].toSorted()
}

/**
 * The one sentence a caller relays.
 */
export function reposSentence(audit: ReposAudit): string {
	const countries = clonedCountries(audit)

	return (
		`${audit.repos.length} ${audit.repos.length === 1 ? "repository" : "repositories"} cloned, covering ` +
		`${countries.length} ${countries.length === 1 ? "country" : "countries"}` +
		`${audit.duplicated.length ? `; ${audit.duplicated.length} checked out TWICE` : "; none checked out twice"}` +
		`${
			audit.duplicated.length
				? audit.diverged.length
					? `, ${audit.diverged.length} at DIFFERENT commits — the ingest's result depends on enumeration order`
					: ", at identical commits, so the cost is read time and disk"
				: ""
		}` +
		`${audit.aliased.length ? `; ${audit.aliased.length} symlinked into the other layout (ingested through the direct path once)` : ""}.`
	)
}
