/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Write each published weights workspace's `LICENSE.md` and `PROVENANCE.json` from its manifest and model card.
 *
 *   The files are committed rather than materialized at pack time, unlike the weights binaries. A binary is
 *   gitignored because it is large and moves with a training run. These are small, they change only when a manifest or
 *   a card changes, and a reviewer has to be able to see a rights statement move in a diff. Committing them also lets
 *   the `weights-rights` repository check hold the tree equal to what this writer produces, so a card edit that
 *   changes an attribution cannot land with the published statement left behind.
 *
 *   Private weights workspaces are skipped. `neural-weights-base-latn` publishes nothing and ships no model card, so a
 *   rights file there would state terms for a tarball that never reaches anyone.
 */

import { readLocalJSONFile, readLocalTextFile } from "@mailwoman/core/fs/readers"
import { writeLocalFile, writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { readPackageJSON } from "@mailwoman/core/module/resolve-from"
import { readWorkspaceDirectories } from "@mailwoman/core/workspaces"
import { resolvePath } from "path-ts"

import {
	LICENSE_FILE,
	PROVENANCE_FILE,
	provenanceMatches,
	renderLicenseFile,
	renderProvenance,
} from "#weights/rights/files"
import { readWeightsRightsRecords, type WeightsRightsRecord } from "#weights/rights/record"

export interface RightsFileState {
	file: string
	changed: boolean
}

/**
 * Every published `neural-weights-*` workspace, in the order `readWorkspaceDirectories` lists them.
 *
 * Read from the root workspace list rather than from `.release-it.json`, because a
 * weights workspace held out of the release still publishes the moment it is added back,
 * and a rights file that only appears at that point is one nobody reviewed.
 */
export async function publishedWeightsWorkspaces(repoRoot: string): Promise<string[]> {
	const workspaces = await readWorkspaceDirectories(repoRoot)
	const published: string[] = []

	for (const workspace of workspaces) {
		if (!workspace.startsWith("packages/neural-weights-")) continue

		const manifest = await readPackageJSON(String(resolvePath(repoRoot, workspace, "package.json")))

		if (manifest.private) continue

		published.push(workspace)
	}

	return published
}

/**
 * The records the writer and the check both work from.
 */
export async function weightsRightsRecords(repoRoot: string): Promise<WeightsRightsRecord[]> {
	return readWeightsRightsRecords(repoRoot, await publishedWeightsWorkspaces(repoRoot))
}

/**
 * Whether the committed file at `path` already holds `expected`.
 *
 * A missing or unreadable file reads as different rather than as equal, so a first run writes it.
 */
async function licenseDiffers(repoRoot: string, workspace: string, expected: string): Promise<boolean> {
	try {
		return (await readLocalTextFile(resolvePath(repoRoot, workspace, LICENSE_FILE))) !== expected
	} catch {
		return true
	}
}

async function provenanceDiffers(repoRoot: string, record: WeightsRightsRecord): Promise<boolean> {
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
	repoRoot: string,
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
