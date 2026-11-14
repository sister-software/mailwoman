// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file What the admin build read, stated as fingerprints of its inputs, so two builds from the
 *   same inputs stamp the same manifest and a later reader can tell which inputs a database came from.
 *
 *   The WOF fingerprint covers each clone's checked-out commit. An uncommitted edit in a clone isn't in it.
 *   The per-repository record cache (#3061 Phase 2) keys on the working tree as well.
 */

import { sortedGlob } from "@mailwoman/core/fs/readers"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { git, gitHead } from "@mailwoman/core/git"
import { sha256File, sha256Hex } from "@mailwoman/core/hash"
import { PathBuilder, type PathBuilderLike } from "path-ts"

/**
 * One WOF clone's checked-out commit and that commit's committer date.
 */
export interface WOFRepoHead {
	repo: string
	head: string
	/**
	 * ISO-8601 committer date of `head`.
	 */
	headDate: string
}

/**
 * The fingerprints the admin manifest records for its inputs.
 */
export interface AdminInputFingerprints {
	/**
	 * `sha256:<16 hex> (<n> repos)` over each clone's `repo@head`, in repository-name order.
	 */
	wof: string
	/**
	 * `sha256:<16 hex> (<n> files)` over each GeoNames input file's name and sha256, in name order.
	 */
	geonames: string
	/**
	 * The newest WOF commit date among the clones, the build's `createdAt`.
	 */
	newestInputDate: string
}

/**
 * Each git checkout directly under `dataDir`, with its head commit and that commit's date, in name order.
 */
export async function readWOFRepoHeads(dataDir: PathBuilderLike): Promise<WOFRepoHead[]> {
	const root = PathBuilder.from(dataDir)
	const heads: WOFRepoHead[] = []

	for (const entry of await sortedGlob(root, "*", { onlyFiles: false })) {
		const repo = PathBuilder.from(entry)

		if (!(await pathExists(repo(".git")))) continue

		heads.push({
			repo: repo.basename(),
			head: await gitHead(repo),
			headDate: (await git(["log", "-1", "--format=%cI"], repo)).trim(),
		})
	}

	return heads
}

/**
 * `sha256:<first 16 hex>` over the lines, with the count, as the manifest records a fingerprint.
 */
function fingerprint(lines: readonly string[], unit: string): string {
	return `sha256:${sha256Hex(lines.join("\n")).slice(0, 16)} (${lines.length} ${unit})`
}

/**
 * Fingerprints the WOF clones and the GeoNames files a build reads.
 *
 * GeoNames files are each country's `<CC>.txt` in `geonamesDir` and `alternateDir` that exist.
 */
export async function fingerprintAdminInputs(input: {
	dataDir: PathBuilderLike
	geonamesCountries: readonly string[]
	geonamesDir: PathBuilderLike
	alternateDir: PathBuilderLike
}): Promise<AdminInputFingerprints> {
	const heads = await readWOFRepoHeads(input.dataDir)
	const files: string[] = []

	for (const [label, dir] of [
		["geonames", input.geonamesDir],
		["geonames-alternate", input.alternateDir],
	] as const) {
		for (const country of input.geonamesCountries.toSorted()) {
			const file = PathBuilder.from(dir)(`${country}.txt`)

			if (await pathExists(file)) {
				files.push(`${label}/${country}.txt ${await sha256File(file)}`)
			}
		}
	}

	const newest = heads.map((head) => head.headDate).toSorted((a, b) => Date.parse(b) - Date.parse(a))[0]

	if (!newest) throw new Error(`fingerprintAdminInputs: no git checkout under ${input.dataDir}`)

	return {
		wof: fingerprint(
			heads.map((head) => `${head.repo}@${head.head}`),
			"repos"
		),
		geonames: fingerprint(files, "files"),
		newestInputDate: new Date(newest).toISOString(),
	}
}
