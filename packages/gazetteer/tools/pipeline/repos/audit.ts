// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Reports the clones in the WOF repos root.
 *   This supplies the other half of `country-plan`.
 *
 *   `country-plan` reads the built artifact to learn what source serves each country.
 *   It cannot report files on disk that await a build.
 *
 *   For the WOF leg, `ingestWOF` globs `**\/data\/**\/*.geojson` under the repos root and reads no list.
 *   The directory contents form the recipe.
 *
 *   The next build includes any clone, whether or not someone declared it.
 *   A declaration without a clone will produce no coverage.
 *
 *   Every clone sits directly under the root at `<root>/<name>`.
 *   Any other directory there's a stray: the ingest's glob reads its GeoJSON as well, so a second copy
 *   of a repository inside a stray makes the ingested value depend on filesystem enumeration order.
 *   The audit lists strays so a sync or a build log can say so.
 */

import { entryLeadsToDirectory, pathExists } from "@mailwoman/core/fs/readers/stat"
import { gitSync } from "@mailwoman/core/git"
import { type PathBuilder, type PathBuilderLike, resolvePathBuilder } from "path-ts"
import { Globerator } from "spliterator/node/fs"

import { PLACETYPES_REPO } from "#whosonfirst/placetypes/Placetype"

export interface ClonedRepo {
	name: string
	/**
	 * `head` of the checkout, or `null` for a directory that's not a git checkout
	 * or when commits weren't read.
	 */
	commit: string | null
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
	 * Directories under the root that are not a repository clone, by name.
	 */
	strays: string[]
	/**
	 * Symbolic links under the root, by name, whether or not they resolve.
	 *
	 * The sync never creates one.
	 * The admin ingest doesn't follow links, so a build omits a repository that's reachable only through one.
	 */
	links: string[]
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
 * Any repository in the two Who's On First data organizations, including those with
 * no country code, such as `whosonfirst-data-admin-alt`.
 */
const DATA_REPO_NAME = /^whosonfirst-(?:data|external)-[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * Whether a directory under the repos root, given by its name, is a Who's On First repository clone.
 */
export function isRepositoryDirectory(name: string): boolean {
	return DATA_REPO_NAME.test(name) || name === PLACETYPES_REPO.name
}

/**
 * `head` for a checkout, or `null` when the directory isn't one.
 *
 * A clone without git metadata can be a directory extracted from an archive.
 * The audit reports its vintage as absent and continues checking the root.
 */
function headOf(dir: PathBuilder): string | null {
	try {
		return gitSync(["rev-parse", "--short", "HEAD"], { cwd: dir })
	} catch {
		return null
	}
}

/**
 * Walk the repos root and report every clone, its vintage, and every directory that's not a clone.
 */
export async function auditReposRoot(
	root: PathBuilderLike,
	options: { readCommits?: boolean } = {}
): Promise<ReposAudit> {
	if (!(await pathExists(root))) return { root, repos: [], strays: [], links: [] }

	const repos: ClonedRepo[] = []
	const strays: string[] = []
	const links: string[] = []

	for await (const entry of Globerator.from("*", { cwd: root, withFileTypes: true, onlyFiles: false })) {
		// Checked before resolving the entry: a link that points at itself makes the resolution throw `ELOOP`.
		if (entry.isSymbolicLink()) {
			links.push(entry.name)

			continue
		}

		if (!(await entryLeadsToDirectory(entry))) continue

		if (!isRepositoryDirectory(entry.name)) {
			strays.push(entry.name)

			continue
		}

		const commit = options.readCommits === false ? null : headOf(resolvePathBuilder(root, entry.name))

		repos.push({ name: entry.name, commit, ...parseRepoName(entry.name) })
	}

	return {
		root,
		repos: repos.toSorted((a, b) => a.name.localeCompare(b.name)),
		strays: strays.toSorted(),
		links: links.toSorted(),
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
	const { links, strays } = audit

	return (
		`${audit.repos.length} ${audit.repos.length === 1 ? "repository" : "repositories"} cloned, covering ` +
		`${countries.length} ${countries.length === 1 ? "country" : "countries"}; ` +
		(strays.length
			? `${strays.length} other ${strays.length === 1 ? "directory" : "directories"} under the root ` +
				`(${strays.join(", ")}), whose GeoJSON the admin ingest also reads`
			: "every directory under the root is a repository clone") +
		(links.length
			? `; ${links.length} symbolic ${links.length === 1 ? "link" : "links"} (${links.join(", ")}), ` +
				"which the admin ingest does not follow."
			: ".")
	)
}
