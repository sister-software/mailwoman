/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The Cloudflare Workers this repository deploys, and which of them a change reaches. The table is the one
 *   place a target's build, wrangler invocation and receipt URL are written; the deploy workflow reads it through
 *   `release.deploy-targets` as a job matrix, so a new Worker is one row here and no YAML.
 *
 *   A target is affected when a changed file lies in a workspace inside its dependency closure, or in a root file
 *   every build reads. The closure comes from the manifests (`walkWorkspaceClosure`), not from a watch list: a
 *   dependency added to a manifest is picked up the same push, where a hand-kept path list drifts until someone
 *   notices a stale deployment.
 */

import { walkWorkspaceClosure, workspaceDirectories } from "#release/workspace-closure"

export type DeployTargetID = "tiles" | "license" | "earth" | "moon" | "mars"

export interface DeployTarget {
	id: DeployTargetID
	/**
	 * The Worker name on Cloudflare, and the concurrency key a deploy holds.
	 */
	worker: string
	workspace: string
	/**
	 * The repo-relative directory `wrangler deploy` runs in.
	 */
	cwd: string
	/**
	 * The build command run after the compile, or an empty string when the compile is the whole build.
	 */
	build: string
	/**
	 * `PLANETARY_BODY` for the two planetary builds; empty for every other target.
	 */
	body: string
	/**
	 * Arguments after `wrangler deploy`.
	 */
	deployArgs: string
	/**
	 * Fetched after the deploy; a non-2xx answer fails the job.
	 */
	receipt: string
}

const PLANETARY_BUILD = "yarn workspace @mailwoman/planetary build"

/**
 * The five Workers, in the order the workflow lists them.
 */
export const DEPLOY_TARGETS: readonly DeployTarget[] = [
	{
		id: "tiles",
		worker: "mailwoman-tiles",
		workspace: "@mailwoman/tile-worker",
		cwd: "packages/tile-worker",
		build: "",
		body: "",
		deployArgs: "",
		receipt: "https://tiles.mailwoman.ai/basemap-v4.json",
	},
	{
		id: "license",
		worker: "mailwoman-license",
		workspace: "@mailwoman/license-worker",
		cwd: "packages/license-worker",
		build: "",
		body: "",
		deployArgs: "",
		receipt: "https://license.mailwoman.ai/health",
	},
	{
		id: "earth",
		worker: "mailwoman-earth",
		workspace: "@mailwoman/earth",
		cwd: "packages/earth",
		build: "yarn workspace @mailwoman/earth build",
		body: "",
		deployArgs: "",
		receipt: "https://earth.mailwoman.ai/build.json",
	},
	{
		id: "moon",
		worker: "mailwoman-moon",
		workspace: "@mailwoman/planetary",
		cwd: "packages/planetary",
		build: PLANETARY_BUILD,
		body: "moon",
		deployArgs: "--env moon",
		receipt: "https://moon.mailwoman.ai/build.json",
	},
	{
		id: "mars",
		worker: "mailwoman-mars",
		workspace: "@mailwoman/planetary",
		cwd: "packages/planetary",
		build: PLANETARY_BUILD,
		body: "mars",
		deployArgs: "--env mars",
		receipt: "https://mars.mailwoman.ai/build.json",
	},
]

/**
 * The target ids in table order: what `--targets` accepts and the workflow's dispatch input names.
 */
export const DEPLOY_TARGET_IDS: readonly DeployTargetID[] = DEPLOY_TARGETS.map((target) => target.id)

/**
 * Root files every target's build reads. A change to one deploys everything, because no workspace closure names it.
 */
export const ROOT_BUILD_PATHS: readonly string[] = [
	"package.json",
	"yarn.lock",
	".yarnrc.yml",
	".nvmrc",
	"tsconfig.json",
	".github/workflows/deploy.yml",
]

/**
 * The workspace a repo-relative path belongs to, by the longest workspace directory that prefixes it, or null for a
 * path outside every workspace.
 */
export function workspaceOfPath(dirsByName: ReadonlyMap<string, string>, path: string): string | null {
	let best: { name: string; length: number } | null = null

	for (const [name, dir] of dirsByName) {
		if ((path === dir || path.startsWith(`${dir}/`)) && (best === null || dir.length > best.length)) {
			best = { name, length: dir.length }
		}
	}

	return best?.name ?? null
}

export interface DeploySelection {
	target: DeployTarget
	/**
	 * What reached the target: the changed workspaces in its closure, or the root file, or `all`.
	 */
	reasons: string[]
}

/**
 * The targets a set of changed paths reaches, given each target's closure as workspace names. Pure, so the rule is
 * testable without a checkout.
 */
export function selectDeployTargets(
	changed: readonly string[],
	closures: ReadonlyMap<DeployTargetID, ReadonlySet<string>>,
	dirsByName: ReadonlyMap<string, string>
): DeploySelection[] {
	const rootChanges = changed.filter((path) => ROOT_BUILD_PATHS.includes(path))

	const changedWorkspaces = new Set(
		changed.map((path) => workspaceOfPath(dirsByName, path)).filter((name): name is string => name !== null)
	)

	const selections: DeploySelection[] = []

	for (const target of DEPLOY_TARGETS) {
		const closure = closures.get(target.id)

		if (!closure) throw new Error(`deploy targets: no closure for ${target.id}`)

		const reasons = [...rootChanges, ...[...changedWorkspaces].filter((name) => closure.has(name))]

		if (reasons.length) {
			selections.push({ target, reasons })
		}
	}

	return selections
}

/**
 * Every target, with `all` as the reason: a hand deploy asks for this.
 */
export function allDeployTargets(): DeploySelection[] {
	return DEPLOY_TARGETS.map((target) => ({ target, reasons: ["all"] }))
}

/**
 * The targets the changed paths reach in this checkout, each target's closure walked from its manifest.
 */
export async function affectedDeployTargets(repoRoot: string, changed: readonly string[]): Promise<DeploySelection[]> {
	const dirsByName = await workspaceDirectories(repoRoot)
	const closures = new Map<DeployTargetID, ReadonlySet<string>>()

	for (const target of DEPLOY_TARGETS) {
		closures.set(target.id, new Set((await walkWorkspaceClosure(repoRoot, [target.workspace])).keys()))
	}

	return selectDeployTargets(changed, closures, dirsByName)
}
