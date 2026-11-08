/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file A weights workspace holds every untracked artifact its `files` array names, or none of them.
 *
 *   `resolveWeights` resolves a locale from the first directory holding the model binaries, then reads each
 *   companion artifact from that directory and treats an absent one as unshipped. A workspace holding part of
 *   its declared set therefore resolves as a smaller artifact set than the published tarball ships. A grade
 *   read through that workspace measures the smaller set. A bare workspace defers to the data-root overlay, and
 *   a complete one matches the tarball, so both pass.
 *
 *   A checkout always holds its tracked declared files, so the check counts only the untracked ones.
 *   `mwops release copy-weights` and `fetch-hf-weights` write those. The check reads the paths a tracked
 *   manifest names and walks no directory.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { resolvePath } from "path-ts"

import { literalFilesEntries } from "#release-kit/pack/verify-tarball"
import { type Diagnostic, DiagnosticSeverity, type RepoCheck } from "#repo-health/check"

/**
 * The `weights-materialization` check: one error per weights workspace that
 * holds part of its untracked declared set.
 */
export const weightsMaterializationCheck: RepoCheck = {
	id: "weights-materialization",
	description:
		"Every weights workspace holds all of the untracked artifacts its `files` array declares, or none of them.",

	async run({ repoRoot, trackedFiles }): Promise<Diagnostic[]> {
		const diagnostics: Diagnostic[] = []
		const tracked = new Set(trackedFiles)

		const manifestPaths = trackedFiles.filter((file) => /^packages\/neural-weights-[^/]+\/package\.json$/u.test(file))

		for (const manifestPath of manifestPaths) {
			const workspace = manifestPath.slice(0, -"/package.json".length)
			const manifest = await readLocalJSONFile<{ files?: unknown }>(resolvePath(repoRoot, manifestPath))

			const untracked = literalFilesEntries(manifest.files).filter((entry) => !tracked.has(`${workspace}/${entry}`))
			const present: string[] = []
			const missing: string[] = []

			for (const entry of untracked) {
				if (await pathExists(resolvePath(repoRoot, workspace, entry))) {
					present.push(entry)
				} else {
					missing.push(entry)
				}
			}

			if (!present.length || !missing.length) continue

			diagnostics.push({
				severity: DiagnosticSeverity.Error,
				message:
					`${workspace} holds ${present.length} of the ${untracked.length} untracked artifacts its "files" array ` +
					`declares and lacks ${missing.join(", ")}. A resolver reading this workspace treats those as unshipped. ` +
					"Run `mwops release copy-weights` to complete it, or remove the present ones so the data-root overlay resolves.",
				file: manifestPath,
				line: null,
				details: missing,
			})
		}

		return diagnostics
	},
}
