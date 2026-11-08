// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   This function reads a place from a cloned Who's On First data repository.
 *
 *   WOF stores each record at a path derived from its own ID. The decimal ID is split into three-character directories,
 *   followed by `<id>.geojson`. `85977539` lives at `859/775/39/85977539.geojson`. The data does not state this rule.
 *   It is layout knowledge every reader needs, so it lives here beside the {@link WOFFeature} type for parsed records.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { isDirectory, pathExists } from "@mailwoman/core/fs/readers/stat"
import { resolvePath, resolvePathBuilder, type PathBuilderLike } from "path-ts"

import type { WOFFeature } from "#whosonfirst/placetypes/admin"

/**
 * The upstream GitHub organization holding the country data repositories.
 *
 * It is also the prefix of every country repository's name.
 * Clones are made from the `mailwoman` fork of each repository, so this organization
 * appears in a clone's `upstream` remote and never in its path.
 */
export const WOF_DATA_OWNER = "whosonfirst-data"

/**
 * The repository name for a country's data of one theme — `whosonfirst-data-admin-tr`.
 *
 * Four call sites used to build this string themselves, each with its own `toLowerCase()`,
 * which is how a country code arriving uppercase became a directory that silently does not exist.
 */
export function wofRepoName(theme: "admin" | "postalcode" | "venue", country: string): string {
	return `${WOF_DATA_OWNER}-${theme}-${country.toLowerCase()}`
}

/**
 * The directory a repository's clone occupies: `<root>/<name>`.
 *
 * Every Who's On First repository is cloned once, directly under the repositories root,
 * by `gazetteer inspect sync`.
 * The repository names are unique across the upstream organizations, so the path needs no owner segment.
 */
export function wofClonePath(reposRoot: PathBuilderLike, name: string): string {
	return resolvePath(reposRoot, name).toString()
}

/**
 * Find a cloned repository under a repositories root, or `null` when it is not cloned.
 */
export async function resolveWOFRepo(reposRoot: PathBuilderLike, name: string): Promise<string | null> {
	const candidate = wofClonePath(reposRoot, name)

	return (await isDirectory(candidate)) ? candidate : null
}

/**
 * The `data` directory of a country's repository, or `null` when the repository is not cloned.
 *
 * The pairing every reader needs: {@link readWOFFeature} takes roots that already point into `data`.
 */
export async function resolveWOFDataDir(
	reposRoot: PathBuilderLike,
	theme: "admin" | "postalcode" | "venue",
	country: string
): Promise<string | null> {
	const repo = await resolveWOFRepo(reposRoot, wofRepoName(theme, country))

	return repo && resolvePath(repo, "data")
}

/**
 * Characters per directory level.
 *
 * A trailing group shorter than this is its own directory — `85977539` ends in `39`, not `390`.
 */
const ID_CHUNK = 3

/**
 * A WOF id → its repo-relative path segments, ending in `<id>.geojson`.
 *
 * Segments rather than a joined string so a caller can append them to whatever root it already holds.
 * The repos layout puts a `data` directory under each `whosonfirst-data-*` clone.
 * Callers reach it differently.
 */
export function wofIDPathSegments(id: number): string[] {
	const digits = String(id)
	const segments: string[] = []

	for (let i = 0; i < digits.length; i += ID_CHUNK) {
		segments.push(digits.slice(i, i + ID_CHUNK))
	}

	segments.push(`${digits}.geojson`)

	return segments
}

/**
 * Read a place's GeoJSON from the first `root` that holds it, or `null`
 * when no root does or the file will not parse.
 *
 * `null` conflates "absent" with "unparseable" on purpose: every caller
 * so far treats both as "no evidence for this place" and continues.
 * A caller that needs to tell them apart should read the file itself.
 */
export async function readWOFFeature(id: number, roots: readonly PathBuilderLike[]): Promise<WOFFeature | null> {
	const segments = wofIDPathSegments(id)

	for (const root of roots) {
		const path = resolvePathBuilder(root, ...segments)

		if (!(await pathExists(path))) continue

		// Unreadable or unparseable — the file vanished between the probe and the read,
		// or is not JSON — is the same "no evidence" verdict as absent.
		return readLocalJSONFile<WOFFeature>(path).catch(() => null)
	}

	return null
}
