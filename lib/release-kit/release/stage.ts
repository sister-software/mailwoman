/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The staging + audit half of the release preflight: materialize the release tree in an isolated
 *   staging root, then pack and audit every release workspace there, so a preflight exercises the
 *   exact pack-and-verify path CI publishes with — without a tag, a registry write, or a dirty source
 *   checkout.
 *
 *   A staging tree built by `git archive head` holds tracked files only and lives outside the
 *   checkout, so an interrupted run leaves every tracked file byte-identical by construction rather
 *   than by cleanup code that must survive kill signals.
 */

import { pathExists, readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { createSymbolicLink, copyPath, makeDirectories, removePathIfPresent } from "@mailwoman/core/fs/writers"
import { readWorkspaceDirectories } from "@mailwoman/core/workspaces"
import { PathBuilder, resolvePath, type PathBuilderLike } from "path-ts"
import { $ } from "zx"

import { packWorkspaceForPublish } from "#release-kit/pack/pack-workspace"
import { verifyTarball } from "#release-kit/pack/verify-tarball"

/**
 * The root workspaces that sit outside `.release-it.json`'s publish list,
 * each with the reason a reader can state.
 */
export const SANCTIONED_RELEASE_ABSENCES = await import("@mailwoman/universe/release-it.json", {
	with: { type: "json" },
}).then((module) => module.default.absences as Record<string, string>)

/**
 * Refuse to publish a workspace this repository holds out of the release, naming the recorded reason.
 *
 * Every entry is refused rather than only the rights-held ones, so one rule cannot
 * drift from a classification it does not include.
 */
export function assertWorkspacePublishable(workspacePath: string): void {
	const workspace = workspacePath.replace(/^\.\//, "").replace(/\/$/, "")
	const reason = SANCTIONED_RELEASE_ABSENCES[workspace]

	if (!reason) return

	throw new Error(
		`release hold: ${workspace} is held out of the release and will not be published — ${reason}. ` +
			`Publishing it means removing its entry from SANCTIONED_RELEASE_ABSENCES in lib/release-kit/release/stage.ts and adding it to .release-it.json.`
	)
}

/**
 * The publish set, verbatim from `.release-it.json` — the list both CI phases derive from.
 *
 * @throws On a missing, empty, or non-string list: every caller treats this
 * as the full bump/publish surface.
 * An empty read must never be mistaken for zero workspaces.
 */
export async function releaseWorkspaces(repoRoot: PathBuilderLike): Promise<string[]> {
	const config = await readLocalJSONFile<{
		plugins?: { "@release-it-plugins/workspaces"?: { workspaces?: unknown } }
	}>(resolvePath(repoRoot, ".release-it.json"))

	const workspaces = config.plugins?.["@release-it-plugins/workspaces"]?.workspaces

	if (!Array.isArray(workspaces) || !workspaces.length) {
		throw new Error("could not read a non-empty workspaces array from .release-it.json")
	}

	const list = workspaces.filter((entry): entry is string => typeof entry === "string")

	if (list.length !== workspaces.length) {
		throw new Error(".release-it.json workspaces array carries a non-string entry")
	}

	return list
}

export interface ReleaseListIdentity {
	/**
	 * Workspaces in the root `workspaces` array but neither in the release list nor sanctioned.
	 *
	 * Each one is silently frozen at its last published version until someone answers for it.
	 */
	unexpectedAbsences: string[]
	/**
	 * Sanctioned absences that no longer exist in the root `workspaces` array.
	 */
	staleSanctions: string[]
	/**
	 * Release-list entries missing from the root `workspaces` array.
	 */
	danglingReleaseEntries: string[]
	publishCount: number
}

/**
 * The absence identity: root `workspaces` minus the release list must equal the sanctioned set exactly.
 */
export async function checkReleaseListIdentity(repoRoot: PathBuilderLike): Promise<ReleaseListIdentity> {
	const root = await readWorkspaceDirectories(repoRoot)

	const release = new Set(await releaseWorkspaces(repoRoot))
	const rootSet = new Set(root)
	const absences = root.filter((workspace) => !release.has(workspace))

	return {
		unexpectedAbsences: absences.filter((workspace) => !(workspace in SANCTIONED_RELEASE_ABSENCES)),
		staleSanctions: Object.keys(SANCTIONED_RELEASE_ABSENCES).filter((workspace) => !rootSet.has(workspace)),
		danglingReleaseEntries: [...release].filter((workspace) => !rootSet.has(workspace)),
		publishCount: release.size,
	}
}

/**
 * Materialize the release tree into `stagingRoot`, replacing any existing tree
 * and leaving the caller to own its lifecycle.
 *
 * `git archive head` supplies tracked files only, each release workspace's compiled `out/` is
 * copied in because tarballs ship compiled JS + `.d.ts`, and the checkout's `node_modules`
 * is symlinked because `yarn pack` needs the project context and never writes it.
 */
export async function stageReleaseTree(repoRoot: string, stagingRoot: PathBuilderLike): Promise<void> {
	const staging = PathBuilder.from(stagingRoot)
	const root = PathBuilder.from(repoRoot)

	await removePathIfPresent(staging)
	await makeDirectories(staging)

	await $({ cwd: repoRoot })`git archive HEAD`.pipe($`tar -x -C ${staging.toString()}`)

	for (const workspace of await releaseWorkspaces(repoRoot)) {
		const compiled = root(workspace, "out")

		if (await pathExists(compiled)) {
			await copyPath(compiled, staging(workspace, "out"))
		}
	}

	await createSymbolicLink(root("node_modules"), staging("node_modules"))
}

/**
 * One workspace's pack-and-audit outcome.
 *
 * A pack that could not produce a tarball reports the thrown message as its
 * single failure rather than aborting the sweep.
 */
export interface WorkspaceAuditResult {
	workspace: string
	ok: boolean
	failures: string[]
	/**
	 * Entry counts from the tarball audit, absent when the pack or the audit failed.
	 */
	counts?: { literalFiles: number; exportTargets: number; binTargets: number }
}

/**
 * Pack and audit every release workspace in the staged tree, collecting every failure
 * so one run reports every broken package instead of stopping at the first.
 */
export async function auditStagedWorkspaces(
	stagingRoot: PathBuilderLike,
	workspaces: readonly string[]
): Promise<WorkspaceAuditResult[]> {
	const staging = PathBuilder.from(stagingRoot)
	const tarballDir = staging(".preflight-tarballs")

	await makeDirectories(tarballDir)

	const results: WorkspaceAuditResult[] = []

	// Sequential and awaited: the pack edits and restores the workspace manifest,
	// so it must finish before the audit opens the tarball.
	for (const workspace of workspaces) {
		const tarball = tarballDir(`${workspace.replaceAll("/", "__")}.tgz`)

		try {
			await packWorkspaceForPublish(staging(workspace), tarball)

			// Throws listing every violation.
			// Caught below so one sweep reports every broken package.
			const audit = verifyTarball(tarball)

			results.push({
				workspace,
				ok: true,
				failures: [],
				counts: {
					literalFiles: audit.literalFiles,
					exportTargets: audit.exportTargets,
					binTargets: audit.binTargets,
				},
			})
		} catch (error) {
			results.push({ workspace, ok: false, failures: [(error as Error).message] })
		}
	}

	return results
}
