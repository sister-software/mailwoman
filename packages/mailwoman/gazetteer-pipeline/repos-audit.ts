/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   What is actually cloned in the WOF repos root — the other half of `country-plan`.
 *
 *   `country-plan` reads the built artifact, which answers "what source serves this country". It cannot
 *   answer "what is on disk waiting to be built", and for the WOF leg those are different questions:
 *   `ingestWOF` globs `**\/data\/**\/*.geojson` over the repos root and reads no list, so THE DIRECTORY IS
 *   THE RECIPE. A clone that landed is coverage the next build will pick up whether or not anyone declared
 *   it, and a declaration with no clone is coverage that will silently not appear.
 *
 *   TWO LAYOUTS COEXIST, and a repo present in both is one of two DIFFERENT things — which is why this
 *   distinguishes them rather than counting paths. Measured 2026-08-17 in the lab root:
 *
 *   - `admin-jp` and `admin-kr` are two INDEPENDENT checkouts, at identical commits today.
 *   - `admin-us` is one checkout reachable twice: the nested path is a SYMLINK to the flat one. Comparing
 *       `ls` output calls this a duplicate, and it is not — a directory cannot diverge from itself.
 *
 *   Both cost a double read, because `ingest-wof` passes no `followSymbolicLinks` and fast-glob defaults it
 *   to `true`, so the glob descends the alias as readily as the copy. `spr` is written `INSERT OR REPLACE`,
 *   so the second write is idempotent and today the whole thing costs read time and disk.
 *
 *   Only the INDEPENDENT copies carry the further hazard. The moment they diverge — one pulled, one not —
 *   the ingested value is LAST-WRITER-WINS over FastGlob's enumeration order, which nobody stated and
 *   `verifyAdmin` cannot catch because it tests floors. An alias can never reach that state, so reporting
 *   the two as one number would either overstate the risk or hide it.
 */

import { execFileSync } from "node:child_process"
import { type Dirent, existsSync, readdirSync, realpathSync, statSync } from "node:fs"
import { join } from "node:path"

/**
 * Where a clone sits relative to the repos root.
 */
export const CloneLayout = {
	/**
	 * `<root>/<name>` — what the postcode build read before #1727 taught it both.
	 */
	Flat: "flat",
	/**
	 * `<root>/<owner>/<name>` — what `gazetteer inspect sync` writes.
	 */
	Nested: "nested",
} as const

export type CloneLayout = (typeof CloneLayout)[keyof typeof CloneLayout]

export interface ClonedRepo {
	name: string
	layouts: CloneLayout[]
	/**
	 * True when the layouts resolve to the SAME directory — a symlink, not a second checkout. It still costs a double
	 * read, and it can never diverge.
	 */
	aliased: boolean
	/**
	 * `HEAD` per layout, so a duplicate can be reported as SAME or DIVERGED rather than merely as duplicated. Absent for
	 * a directory that is not a git checkout.
	 */
	commits: Partial<Record<CloneLayout, string>>
	/**
	 * The ISO-2 country the repo name encodes, or `undefined` for a repo that names none (`whosonfirst-placetypes`).
	 */
	country?: string
	theme?: string
}

export interface ReposAudit {
	root: string
	repos: ClonedRepo[]
	/**
	 * Repos present in both layouts as INDEPENDENT checkouts. Named separately because the count is the finding.
	 */
	duplicated: ClonedRepo[]
	/**
	 * Repos reachable through both layouts via a symlink — one physical copy. Read twice by the ingest, but incapable of
	 * the divergence that makes {@link ReposAudit.duplicated} a correctness question rather than a cost one.
	 */
	aliased: ClonedRepo[]
	/**
	 * Duplicated repos whose two copies are at DIFFERENT commits — the state where the ingest's result depends on
	 * enumeration order. Empty is the good case and is reported as such.
	 */
	diverged: ClonedRepo[]
}

const REPO_NAME = /^whosonfirst-(?:data|external)-(?<theme>[a-z]+(?:-[a-z]+)*?)-(?<country>[a-z]{2})$/

/**
 * Split a repo name into its theme and country, when it carries one.
 */
export function parseRepoName(name: string): { theme?: string; country?: string } {
	const match = REPO_NAME.exec(name)

	if (!match?.groups) return {}

	return { theme: match.groups["theme"], country: match.groups["country"]?.toUpperCase() }
}

/**
 * Whether a directory entry leads to a directory, symlink included.
 *
 * `Dirent.isDirectory()` is FALSE for a symlink to a directory, and that is not a detail: the lab's nested
 * `whosonfirst-data-admin-us` is exactly such a link, so a walk keyed on `isDirectory()` alone skips it and reports the
 * repo as single-layout. Fast-glob does not skip it — `ingest-wof` passes no `followSymbolicLinks` and the default is
 * `true` — so the audit would be describing a tree the ingest does not see.
 */
function leadsToDirectory(entry: Dirent, full: string): boolean {
	if (entry.isDirectory()) return true

	if (!entry.isSymbolicLink()) return false

	try {
		return statSync(full).isDirectory()
	} catch {
		// A broken link leads nowhere, which is the correct answer rather than an error.
		return false
	}
}

/**
 * `HEAD` for a checkout, or `undefined` when the directory is not one.
 *
 * A clone with no git metadata is not an error here — it is a directory someone extracted from an archive, and
 * reporting the vintage as absent is more useful than refusing to audit the root.
 */
function headOf(dir: string): string | undefined {
	try {
		return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: dir, encoding: "utf8", stdio: "pipe" }).trim()
	} catch {
		return undefined
	}
}

/**
 * Walk the repos root and report every clone, its layout(s) and its vintage.
 *
 * Only two levels are examined, because only two layouts exist: a repo directly under the root, and a repo under an
 * owner directory. Anything deeper is a repo's own contents.
 */
export function auditReposRoot(root: string, options: { readCommits?: boolean } = {}): ReposAudit {
	const byName = new Map<string, ClonedRepo>()

	const realPaths = new Map<string, string[]>()

	const record = (name: string, layout: CloneLayout, dir: string): void => {
		const existing = byName.get(name) ?? { name, layouts: [], commits: {}, aliased: false, ...parseRepoName(name) }

		existing.layouts.push(layout)

		// `realpath` is what separates a second checkout from a second PATH to the first. Comparing directory
		// listings cannot: both shapes look identical from `ls`.
		try {
			realPaths.set(name, [...(realPaths.get(name) ?? []), realpathSync(dir)])
		} catch {
			// Unresolvable (a broken link). Left out of the alias comparison rather than guessed at.
		}

		if (options.readCommits !== false) {
			const head = headOf(dir)

			if (head) {
				existing.commits[layout] = head
			}
		}

		byName.set(name, existing)
	}

	if (!existsSync(root)) return { root, repos: [], duplicated: [], aliased: [], diverged: [] }

	for (const entry of readdirSync(root, { withFileTypes: true })) {
		const full = join(root, entry.name)

		if (!leadsToDirectory(entry, full)) continue

		if (entry.name.startsWith("whosonfirst-data-") || entry.name.startsWith("whosonfirst-external-")) {
			record(entry.name, CloneLayout.Flat, full)

			continue
		}

		// An owner directory. Its children are the nested layout; a name that is itself a repo was handled above.
		for (const child of readdirSync(full, { withFileTypes: true })) {
			const childPath = join(full, child.name)

			if (child.name.startsWith("whosonfirst-") && leadsToDirectory(child, childPath)) {
				record(child.name, CloneLayout.Nested, childPath)
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
 * Which countries the repos root would contribute to a build, whatever any list says.
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
		`${audit.aliased.length ? `; ${audit.aliased.length} symlinked into the other layout (read twice, cannot diverge)` : ""}.`
	)
}
