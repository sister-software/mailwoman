// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Write each published weights workspace's `LICENSE.md` and `PROVENANCE.json`
 *   from its manifest and model card.
 *
 *   The files are committed rather than materialized at pack time.
 *   They change only when a manifest or card changes.
 *
 *   Reviewers can see each rights statement in the diff.
 *   The `weights-rights` check keeps the tree equal to this writer's output.
 *
 *   Private weights workspaces are skipped, because a rights file there would
 *   state terms for a tarball that never publishes.
 */

import { readLocalJSONFile, readLocalTextFile } from "@mailwoman/core/fs/readers"
import { writeLocalFile, writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { readPackageJSON } from "@mailwoman/core/module/resolve-from"
import { readWorkspaceDirectories } from "@mailwoman/core/repo/workspaces"
import { type PathBuilderLike, resolvePath } from "path-ts"

import {
	LICENSE_FILE,
	PROVENANCE_FILE,
	modelGraphUncompared,
	provenanceMatches,
	renderLicenseFile,
	renderProvenance,
} from "#release-kit/weights/rights/files"
import { readWeightsRightsRecords, type WeightsRightsRecord } from "#release-kit/weights/rights/record"

export interface RightsFileState {
	file: string
	changed: boolean
}

/**
 * Every published `neural-weights-*` workspace, in the order `readWorkspaceDirectories` lists them.
 *
 * Read from the root workspace list rather than `.release-it.json`, because a weights
 * workspace held out of the release can publish as soon as it is added back.
 * A rights file that appears only then has no review record.
 */
async function publishedWeightsWorkspaces(repoRoot: PathBuilderLike): Promise<string[]> {
	const workspaces = await readWorkspaceDirectories(repoRoot)
	const published: string[] = []

	for (const workspace of workspaces) {
		if (!workspace.startsWith("packages/neural-weights-")) continue

		const manifest = await readPackageJSON(resolvePath(repoRoot, workspace, "package.json"))

		if (manifest.private) continue

		published.push(workspace)
	}

	return published
}

/**
 * The records the writer and the check both work from.
 */
export async function weightsRightsRecords(repoRoot: PathBuilderLike): Promise<WeightsRightsRecord[]> {
	return readWeightsRightsRecords(repoRoot, await publishedWeightsWorkspaces(repoRoot))
}

/**
 * Whether the committed file at `path` already holds `expected`; a missing
 * or unreadable file reads as different, so a first run writes it.
 */
async function licenseDiffers(repoRoot: PathBuilderLike, workspace: string, expected: string): Promise<boolean> {
	try {
		return (await readLocalTextFile(resolvePath(repoRoot, workspace, LICENSE_FILE))) !== expected
	} catch {
		return true
	}
}

async function provenanceDiffers(repoRoot: PathBuilderLike, record: WeightsRightsRecord): Promise<boolean> {
	try {
		const committed = await readLocalJSONFile<unknown>(resolvePath(repoRoot, record.workspace, PROVENANCE_FILE))

		return !provenanceMatches(committed, record)
	} catch {
		return true
	}
}

/**
 * Write both rights files for every published weights workspace, reporting which ones moved.
 */
export async function writeWeightsRightsFiles(
	repoRoot: PathBuilderLike,
	log: (line: string) => void
): Promise<RightsFileState[]> {
	const states: RightsFileState[] = []

	for (const record of await weightsRightsRecords(repoRoot)) {
		const license = renderLicenseFile(record)
		const licenseChanged = await licenseDiffers(repoRoot, record.workspace, license)

		if (licenseChanged) {
			await writeLocalFile(license, resolvePath(repoRoot, record.workspace, LICENSE_FILE))
		}

		const provenanceChanged = await provenanceDiffers(repoRoot, record)

		const unreadGraph = modelGraphUncompared(record)

		// A file written here would replace the committed graph with the statement that it went unread.
		if (provenanceChanged && unreadGraph) {
			throw new Error(
				`${record.workspace}/${PROVENANCE_FILE} needs rewriting, and this machine can't read its model graph (${unreadGraph}). ` +
					"Run `yarn mwops release copy-weights` first, or write the file on a machine that holds the model."
			)
		}

		if (provenanceChanged) {
			await writeLocalJSONFile(renderProvenance(record), resolvePath(repoRoot, record.workspace, PROVENANCE_FILE))
		}

		for (const [file, changed] of [
			[`${record.workspace}/${LICENSE_FILE}`, licenseChanged],
			[`${record.workspace}/${PROVENANCE_FILE}`, provenanceChanged],
		] as const) {
			log(`${changed ? "changed  " : "unchanged"} ${file}`)
			states.push({ file, changed })
		}
	}

	return states
}
