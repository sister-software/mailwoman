/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The staging + audit half of the #1894 release preflight: materialize the release tree in an
 *   ISOLATED staging root, then pack and audit every release workspace there — so a preflight can
 *   exercise the exact pack-and-verify path CI publishes with, without a tag, a registry write, or a
 *   dirty source checkout.
 *
 *   Why staging is the mechanism and not try/finally: `packWorkspaceForPublish` EDITS the workspace
 *   manifest in place while packing (the injected `publishConfig.exports`) and restores it after — a
 *   killed process mid-pack leaves the manifest dirty. A staging tree built by `git archive HEAD`
 *   contains tracked files only and lives outside the checkout, so an interrupted run leaves every
 *   tracked file byte-identical BY CONSTRUCTION rather than by cleanup code that must survive kill
 *   signals. Measured on this tree: `yarn pack` runs in the staged copy against a symlinked
 *   `node_modules` (74 ms for `@mailwoman/spatial`) and translates `workspace:*` to the concrete
 *   sibling version exactly as the publish path does.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs"
import { join, resolve } from "node:path"

import { parseJSONStrict } from "@mailwoman/core/objects"
import { $ } from "zx"

import { packWorkspaceForPublish } from "./pack-workspace.ts"
import { verifyTarball } from "./verify-tarball.ts"

/**
 * The root workspaces that are OUTSIDE `.release-it.json`'s publish list, each with the reason a reader can state. The
 * identity check below fails on any absence NOT in this record — "expected 51, found 50" sends someone counting; naming
 * the unexpected workspace is the actionable version, and this record is the data the check owns.
 */
export const SANCTIONED_RELEASE_ABSENCES: Readonly<Record<string, string>> = {
	docs: "private Docusaurus site — never publishes",
	"packages/tile-worker": "private demo-map tile worker — never publishes",
	"packages/geocode-oracle": "private verification oracle — never a runtime dependency, never publishes",
	"packages/neural-weights-base-latn": "parked shared base for #1177 — publish wiring deliberately not landed",
	"packages/dev-mcp": "private maintainer MCP server — never publishes",
	"packages/osm": "public but held out of the release — ODbL counsel sign-off pending (packages/osm/README.md)",
	"packages/flood":
		"new npm name — awaiting the bless-package first publish, which npm Trusted Publishing cannot do from CI " +
		"(RELEASING.md, “Adding a NEW package”). Joining the list before that fails the whole release at this " +
		"workspace with a bare E404.",
	"packages/soil":
		"new npm name — awaiting the bless-package first publish, for the same reason as @mailwoman/flood above. " +
		"An unblessed name fails the whole release at this workspace with a bare E404.",
}

/**
 * The publish set, verbatim from `.release-it.json` — the list both CI phases derive from.
 */
export function releaseWorkspaces(repoRoot: string): string[] {
	const config = parseJSONStrict<{
		plugins: { "@release-it-plugins/workspaces": { workspaces: string[] } }
	}>(readFileSync(resolve(repoRoot, ".release-it.json"), "utf8"))

	return config.plugins["@release-it-plugins/workspaces"].workspaces
}

export interface ReleaseListIdentity {
	/**
	 * Workspaces in the root `workspaces` array but neither in the release list nor sanctioned — each one is silently
	 * frozen at its last published version (the en-au class) until someone answers for it.
	 */
	unexpectedAbsences: string[]
	/**
	 * Sanctioned absences that no longer exist in the root `workspaces` array — a stale entry in
	 * {@link SANCTIONED_RELEASE_ABSENCES} that should be removed.
	 */
	staleSanctions: string[]
	/**
	 * Release-list entries missing from the root `workspaces` array — a list naming a workspace that does not exist.
	 */
	danglingReleaseEntries: string[]
	publishCount: number
}

/**
 * The named-absence identity: root `workspaces` minus the release list must equal the sanctioned set exactly. Every
 * discrepancy is reported by NAME, so the failure is actionable without counting.
 */
export function checkReleaseListIdentity(repoRoot: string): ReleaseListIdentity {
	const root = parseJSONStrict<{ workspaces: string[] }>(
		readFileSync(resolve(repoRoot, "package.json"), "utf8")
	).workspaces

	const release = new Set(releaseWorkspaces(repoRoot))
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
 * Materialize the release tree into `stagingRoot`:
 *
 * 1. `git archive HEAD` — tracked files only, so the staging tree can never leak uncommitted work into an audit and the
 *    source checkout is never written to;
 * 2. Each release workspace's compiled `out/` copied in — tarballs ship compiled JS + `.d.ts`, and `out/` is gitignored;
 * 3. The checkout's `node_modules` symlinked in — `yarn pack` needs the project context, reads it, and never writes it.
 *
 * The caller owns `stagingRoot`'s lifecycle; an existing tree at that path is replaced.
 */
export async function stageReleaseTree(repoRoot: string, stagingRoot: string): Promise<void> {
	rmSync(stagingRoot, { recursive: true, force: true })
	mkdirSync(stagingRoot, { recursive: true })

	await $({ cwd: repoRoot })`git archive HEAD`.pipe($`tar -x -C ${stagingRoot}`)

	for (const workspace of releaseWorkspaces(repoRoot)) {
		const compiled = resolve(repoRoot, workspace, "out")

		if (existsSync(compiled)) {
			cpSync(compiled, join(stagingRoot, workspace, "out"), { recursive: true })
		}
	}

	symlinkSync(resolve(repoRoot, "node_modules"), join(stagingRoot, "node_modules"))
}

/**
 * One workspace's pack-and-audit outcome. `failures` is empty on a clean pack; a pack that could not even produce a
 * tarball reports the thrown message as its single failure rather than aborting the sweep.
 */
export interface WorkspaceAuditResult {
	workspace: string
	ok: boolean
	failures: string[]
	/**
	 * Entry counts from the tarball audit, for the per-workspace report line. Absent when the pack or the audit failed.
	 */
	counts?: { literalFiles: number; exportTargets: number; binTargets: number }
}

/**
 * Pack and audit every release workspace in the staged tree, collecting EVERY failure — one run reports every broken
 * package instead of stopping at the first (the v9.2.0 tarball-guard failures surfaced one dispatch apart because the
 * publish loop's per-workspace isolation was the only sweep that existed).
 */
export function auditStagedWorkspaces(stagingRoot: string, workspaces: readonly string[]): WorkspaceAuditResult[] {
	const tarballDir = join(stagingRoot, ".preflight-tarballs")

	mkdirSync(tarballDir, { recursive: true })

	return workspaces.map((workspace) => {
		const tarball = join(tarballDir, `${workspace.replaceAll("/", "__")}.tgz`)

		try {
			packWorkspaceForPublish(join(stagingRoot, workspace), tarball)

			// Throws with every violation listed when the tarball does not honor its manifest — the catch below
			// is the collection point, so one sweep reports every broken package.
			const audit = verifyTarball(tarball)

			return {
				workspace,
				ok: true,
				failures: [],
				counts: {
					literalFiles: audit.literalFiles,
					exportTargets: audit.exportTargets,
					binTargets: audit.binTargets,
				},
			}
		} catch (error) {
			return { workspace, ok: false, failures: [(error as Error).message] }
		}
	})
}
