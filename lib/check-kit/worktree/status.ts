// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * What a working tree lacks before work can start in it, read from outside the tree.
 *
 * Three prerequisites decide readiness, in the order `mwops worktree prepare` fixes them:
 * an installed `node_modules`, a compiled tree no older than its sources,
 * and the weights workspaces `mwops release copy-weights` writes.
 *
 * Each is satisfied, missing, or unread with the reason, and an unread one never counts as satisfied.
 * The tree's position relative to `origin/main` and its environment file are
 * reported beside them, because `prepare` changes neither.
 */

import { resolveEnvFile } from "@mailwoman/core/env/env-file"
import { errorMessage } from "@mailwoman/core/errors/schema"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { type CheckoutLocality, NodeModulesState, readCheckoutLocality } from "@mailwoman/core/module/checkout-locality"
import { commitsAheadBehind, currentBranch, git, gitHead, trackedFiles } from "@mailwoman/core/repo/git"
import { readReleaseConfig } from "@mailwoman/core/repo/release-config"
import { runFile } from "@mailwoman/core/scripting/process"
import { resolvePath } from "path-ts"

import { checkSpawnedTreeFreshness } from "#dev-mcp/process/compiled-tree"
import { copyWeightsTargets } from "#release-kit/weights/copy-weights"
import {
	readWeightsMaterialization,
	type WeightsWorkspaceMaterialization,
} from "#repo-health/checks/weights/materialization"

/**
 * Whether a prerequisite holds.
 */
export const PrerequisiteState = {
	Satisfied: "satisfied",
	Missing: "missing",
	/**
	 * The reader failed, so whether the prerequisite holds is unknown.
	 */
	Unread: "unread",
} as const

export type PrerequisiteState = (typeof PrerequisiteState)[keyof typeof PrerequisiteState]

/**
 * One prerequisite's reading: the state, the sentence that states why, and what the reader found.
 */
type Prerequisite<TDetail> =
	| { state: typeof PrerequisiteState.Satisfied; evidence: string; detail: TDetail }
	| { state: typeof PrerequisiteState.Missing; evidence: string; detail: TDetail }
	| { state: typeof PrerequisiteState.Unread; evidence: string; detail: null }

/**
 * A value read beside the prerequisites, or the reason it couldn't be read.
 */
type Reading<TValue> = ({ read: true } & TValue) | { read: false; reason: string }

/**
 * The steps `prepare` runs, in order.
 * Each step's key is the key of the prerequisite it fixes.
 */
export const PrepareStep = {
	Install: "install",
	Compile: "compile",
	CopyWeights: "copy-weights",
} as const

export type PrepareStep = (typeof PrepareStep)[keyof typeof PrepareStep]

/**
 * The order `prepare` runs its steps in.
 *
 * Each step needs the one before it.
 * `yarn compile` runs the installed compiler.
 *
 * `copy-weights` runs the compiled `mailwoman` CLI to build the postcode and pair-index files.
 */
export const PREPARE_STEP_ORDER: readonly PrepareStep[] = [
	PrepareStep.Install,
	PrepareStep.Compile,
	PrepareStep.CopyWeights,
]

/**
 * One weights workspace's reading, marked with whether `copy-weights` writes it.
 *
 * Only a workspace `copy-weights` writes decides readiness.
 * Another one, such as `neural-weights-base-latn`, stays bare in a checkout
 * and resolves from the data-root overlay.
 */
interface WeightsWorkspaceReading extends WeightsWorkspaceMaterialization {
	writtenByCopyWeights: boolean
}

/**
 * A working tree's status.
 */
export interface WorktreeStatus {
	/**
	 * The path the caller passed.
	 */
	requestedPath: string
	/**
	 * The canonical working tree that contains it.
	 */
	tree: string
	branch: Reading<{ name: string; head: string }>
	prerequisites: {
		[PrepareStep.Install]: Prerequisite<{ state: NodeModulesState; target: string | null }>
		[PrepareStep.Compile]: Prerequisite<{
			newestSource: string | null
			newestCompiled: string | null
			dryRun: BuildDryRun | null
		}>
		[PrepareStep.CopyWeights]: Prerequisite<{ workspaces: WeightsWorkspaceReading[] }>
	}
	origin: Reading<{
		base: string
		ahead: number
		behind: number
		/**
		 * When a fetch last moved `base`, from its reflog, or `null` when the ref keeps no reflog.
		 */
		updatedAt: string | null
		note: string
	}>
	environment: {
		path: string
		present: Reading<{ value: boolean }>
		/**
		 * The file `@mailwoman/core/env` folds in for a process started in the tree: its own `.env`,
		 * or its main checkout's, or `null` when neither exists or the reading failed.
		 */
		resolved: string | null
		/**
		 * The flag that gives a `node` command the calling checkout's environment file, when the tree has none.
		 *
		 * The file is the one `@mailwoman/core/env` resolves for the calling checkout.
		 */
		flag: string | null
	}
	/**
	 * Whether every prerequisite is satisfied.
	 */
	ready: boolean
	/**
	 * The steps that would fix what isn't satisfied, in the order `prepare` runs them.
	 */
	missing: PrepareStep[]
	summary: string
}

/**
 * Run a reader and report a failure as unread with its message.
 */
async function readOrUnread<TDetail>(
	read: () => Promise<Prerequisite<TDetail>>,
	what: string
): Promise<Prerequisite<TDetail>> {
	try {
		return await read()
	} catch (error) {
		return { state: PrerequisiteState.Unread, evidence: `${what} is unread: ${errorMessage(error)}`, detail: null }
	}
}

/**
 * The `node_modules` prerequisite: a directory of the tree's own, as `yarn install` leaves it.
 */
function readInstall(locality: CheckoutLocality): WorktreeStatus["prerequisites"]["install"] {
	const detail = locality.nodeModules

	if (detail.state === NodeModulesState.Directory) {
		return { state: PrerequisiteState.Satisfied, evidence: "node_modules is a directory of the tree's own", detail }
	}

	return {
		state: PrerequisiteState.Missing,
		evidence:
			detail.state === NodeModulesState.Link
				? `node_modules is a link to ${detail.target ?? "a missing target"}; remove it, then install`
				: "node_modules is absent",
		detail,
	}
}

/**
 * The line `tsc -b --dry` prints for each project a build would compile.
 */
const DRY_WOULD_BUILD = /A non-dry build would build project '([^']+)'/u

/**
 * The lines `tsc -b --dry` prints for a project a build would leave compiled as it is.
 */
const DRY_CURRENT = /Project '[^']+' is up to date|A non-dry build would update timestamps for output of project/u

/**
 * A workspace's test project.
 *
 * `tsconfig.test-base.json` makes it `noEmit` and non-incremental.
 * Such a project keeps no output and no build information, so `tsc -b --dry`
 * reports it as out of date after every build.
 */
const TEST_PROJECT = /\/tsconfig\.test\.json$/u

/**
 * What `tsc -b --dry` in the tree reports: the build projects a build would compile,
 * out of the build projects it read.
 *
 * Test projects are counted apart, because the dry run reports each as out of date whatever its state.
 */
interface BuildDryRun {
	wouldBuild: string[]
	projects: number
	testProjects: number
}

/**
 * Read the output of `tsc -b --dry`.
 *
 * @throws When no line reports a build project, because the output then establishes no project's state.
 */
function parseBuildDryRun(output: string): BuildDryRun {
	const wouldBuild: string[] = []
	let projects = 0
	let testProjects = 0

	for (const line of output.split(/\r?\n/u)) {
		const build = DRY_WOULD_BUILD.exec(line)

		if (build && TEST_PROJECT.test(build[1]!)) {
			testProjects++
		} else if (build) {
			wouldBuild.push(build[1]!)

			projects++
		} else if (DRY_CURRENT.test(line)) {
			projects++
		}
	}

	if (!projects) throw new Error("tsc -b --dry printed no line about a build project")

	return { wouldBuild, projects, testProjects }
}

/**
 * Run the tree's own `tsc -b --dry`, which judges each project from its build
 * information, and return its output.
 */
async function runBuildDryRun(tree: string): Promise<string> {
	const { stdout, stderr } = await runFile("yarn", ["tsc", "-b", "--dry"], { cwd: tree, maxBuffer: 16 * 1024 * 1024 })

	return `${stdout}\n${stderr}`
}

/**
 * The compiled-tree prerequisite.
 *
 * The modification-time reader the development server applies before it spawns `out/` decides
 * when `out/` is absent or older than the sources in the workspaces it covers.
 * When the tree has its own install, the tree's `tsc -b --dry` must also report no project to build.
 *
 * The dry run uses the build information TypeScript keeps for each project.
 * It covers every project `yarn compile` builds, including the root `lib/` project
 * the modification-time reader leaves out.
 *
 * @param dryRun Read `tsc -b --dry`, or `null` when the tree has no install to run it with.
 */
async function readCompiled(
	tree: string,
	dryRun: (() => Promise<BuildDryRun>) | null = null
): Promise<WorktreeStatus["prerequisites"]["compile"]> {
	const freshness = await checkSpawnedTreeFreshness(tree)

	const detail = {
		newestSource: freshness.newestSource?.path ?? null,
		newestCompiled: freshness.newestCompiled?.path ?? null,
		dryRun: null as BuildDryRun | null,
	}

	if (!freshness.fresh) {
		return {
			state: PrerequisiteState.Missing,
			evidence: freshness.newestCompiled
				? `out/ is older than the sources: ${detail.newestSource} is newer than ${detail.newestCompiled}`
				: "out/ is absent",
			detail,
		}
	}

	if (!dryRun) {
		return {
			state: PrerequisiteState.Satisfied,
			evidence: `out/ is current: ${detail.newestCompiled} is newer than every source; tsc -b --dry was not run, because the tree has no install`,
			detail,
		}
	}

	detail.dryRun = await dryRun()

	const { wouldBuild, projects } = detail.dryRun

	if (wouldBuild.length) {
		return {
			state: PrerequisiteState.Missing,
			evidence: `out/ is older than the sources: tsc -b --dry would build ${wouldBuild.length} of ${projects} build projects, first ${wouldBuild[0]}`,
			detail,
		}
	}

	return {
		state: PrerequisiteState.Satisfied,
		evidence: `out/ is current: tsc -b --dry reports each of ${projects} build projects up to date`,
		detail,
	}
}

/**
 * The weights prerequisite: every workspace `copy-weights` writes holds each
 * untracked artifact its `files` array declares.
 */
async function readWeights(tree: string): Promise<WorktreeStatus["prerequisites"]["copy-weights"]> {
	const [config, tracked] = await Promise.all([readReleaseConfig(tree), trackedFiles(tree)])

	return readWeightsAgainst(tree, copyWeightsTargets(config), tracked)
}

/**
 * The weights prerequisite for the given `copy-weights` targets and tracked paths.
 */
async function readWeightsAgainst(
	tree: string,
	targets: readonly string[],
	tracked: readonly string[]
): Promise<WorktreeStatus["prerequisites"]["copy-weights"]> {
	const rows = await readWeightsMaterialization(tree, tracked)

	const workspaces = rows.map((row) => ({ ...row, writtenByCopyWeights: targets.includes(row.workspace) }))
	const read = new Set(rows.map((row) => row.workspace))
	const unmanifested = targets.filter((target) => !read.has(target))

	if (unmanifested.length) {
		throw new Error(`release.config.json names ${unmanifested.join(", ")}, and the tree tracks no package.json there`)
	}

	const incomplete = workspaces.filter((row) => row.writtenByCopyWeights && row.missing.length)

	if (!incomplete.length) {
		return {
			state: PrerequisiteState.Satisfied,
			evidence: `each of the ${targets.length} workspaces copy-weights writes holds its declared artifacts`,
			detail: { workspaces },
		}
	}

	return {
		state: PrerequisiteState.Missing,
		evidence: `${incomplete.length} of the ${targets.length} workspaces copy-weights writes lack declared artifacts: ${incomplete
			.map(
				(row) => `${row.workspace.replace(/^packages\//u, "")} lacks ${row.missing.length} of ${row.untracked.length}`
			)
			.join(", ")}`,
		detail: { workspaces },
	}
}

async function readBranch(tree: string): Promise<WorktreeStatus["branch"]> {
	try {
		const [name, head] = await Promise.all([currentBranch(tree), gitHead(tree)])

		return { read: true, name, head }
	} catch (error) {
		return { read: false, reason: errorMessage(error) }
	}
}

/**
 * The reflog's selector date: `origin/main@{2026-11-20T20:42:29+00:00}`.
 */
const REFLOG_DATE = /@\{([^}]+)\}$/u

/**
 * When `ref` last changed, from its newest reflog entry, or `null` when the ref keeps no reflog.
 *
 * A worktree keeps its own `FETCH_HEAD`, so the reflog of the shared remote-tracking
 * ref is the record every tree sees.
 * A fetch that leaves the ref where it was writes no entry.
 */
async function readRefUpdateTime(tree: string, ref: string): Promise<string | null> {
	const selector = await git(["log", "-g", "-1", "--date=iso-strict", "--format=%gd", ref], tree).catch(() => "")
	const date = REFLOG_DATE.exec(selector.trim())?.[1]

	return date ? new Date(date).toISOString() : null
}

/**
 * The tree's position relative to `base`, from the local refs, with the time a fetch last moved `base`.
 */
async function readOrigin(tree: string, base: string): Promise<WorktreeStatus["origin"]> {
	try {
		const { ahead, behind } = await commitsAheadBehind(base, "HEAD", tree)
		const updatedAt = await readRefUpdateTime(tree, base)

		return {
			read: true,
			base,
			ahead,
			behind,
			updatedAt,
			note: `Counted from the local ${base} ref, which reflects the last fetch${updatedAt ? `; a fetch last moved it at ${updatedAt}` : "; the time a fetch last moved it is unread"}.`,
		}
	} catch (error) {
		return { read: false, reason: errorMessage(error) }
	}
}

/**
 * Whether the tree has its own `.env`.
 * The file's contents are never read.
 */
async function readEnvironment(tree: string, callingCheckout: string): Promise<WorktreeStatus["environment"]> {
	const path = resolvePath(tree, ".env")
	let present: Reading<{ value: boolean }>
	let resolved: string | null = null

	try {
		present = { read: true, value: await pathExists(path) }
		// The resolver reads the tree's `.git` pointer and `commondir`, never an environment file.
		resolved = resolveEnvFile(tree)
	} catch (error) {
		present = { read: false, reason: errorMessage(error) }
	}

	const callingFile = resolveEnvFile(callingCheckout) ?? resolvePath(callingCheckout, ".env")

	return {
		path,
		present,
		resolved,
		flag: present.read && present.value ? null : `--env-file=${callingFile}`,
	}
}

/**
 * One line: ready, or each missing or unread prerequisite in the order `prepare` would fix it.
 */
function summarize(status: Omit<WorktreeStatus, "summary">): string {
	if (status.ready) return `${status.tree} is ready`

	const parts = status.missing.map((step) => {
		const prerequisite = status.prerequisites[step]

		return `${step} (${prerequisite.state}: ${prerequisite.evidence})`
	})

	return `${status.tree} is not ready; prepare would run ${parts.join(", then ")}`
}

/**
 * Options for {@link readWorktreeStatus}.
 */
export interface WorktreeStatusOptions {
	/**
	 * The checkout the command runs from.
	 * The flag points at its `.env`.
	 */
	callingCheckout: string
	/**
	 * The ref the position is counted against.
	 *
	 * @defaultValue `origin/main`
	 */
	base?: string
	/**
	 * Return the output of `tsc -b --dry` in the tree, replaced by a test.
	 */
	readBuildDryRunOutput?: (tree: string) => Promise<string>
}

/**
 * Read the status of the working tree that contains `path`.
 *
 * @throws When no working tree contains `path`, because then no field has a tree to describe.
 */
export async function readWorktreeStatus(path: string, options: WorktreeStatusOptions): Promise<WorktreeStatus> {
	const locality = await readCheckoutLocality(path)

	if (!locality) throw new Error(`no git working tree contains ${path}`)

	const tree = locality.entryTree

	const install = readInstall(locality)
	const readDryRunOutput = options.readBuildDryRunOutput ?? runBuildDryRun

	const dryRun =
		install.state === PrerequisiteState.Satisfied ? async () => parseBuildDryRun(await readDryRunOutput(tree)) : null

	const [compile, weights, branch, origin, environment] = await Promise.all([
		readOrUnread(() => readCompiled(tree, dryRun), "the compiled tree"),
		readOrUnread(() => readWeights(tree), "the weights workspaces"),
		readBranch(tree),
		readOrigin(tree, options.base ?? "origin/main"),
		readEnvironment(tree, options.callingCheckout),
	])

	const prerequisites = { install, compile, "copy-weights": weights }

	const missing = PREPARE_STEP_ORDER.filter((step) => prerequisites[step].state !== PrerequisiteState.Satisfied)

	const status = {
		requestedPath: path,
		tree,
		branch,
		prerequisites,
		origin,
		environment,
		ready: !missing.length,
		missing,
	}

	return { ...status, summary: summarize(status) }
}

/**
 * The status as lines: the summary, then one line per field.
 */
export function renderWorktreeStatus(status: WorktreeStatus): string[] {
	const lines = [
		status.summary,
		`branch: ${status.branch.read ? `${status.branch.name} at ${status.branch.head}` : `unread (${status.branch.reason})`}`,
	]

	for (const step of PREPARE_STEP_ORDER) {
		const prerequisite = status.prerequisites[step]

		lines.push(`${step}: ${prerequisite.state}; ${prerequisite.evidence}`)
	}

	const { origin, environment } = status

	lines.push(
		origin.read
			? `${origin.base}: ${origin.behind} commit(s) behind, ${origin.ahead} ahead. ${origin.note}`
			: `origin: unread (${origin.reason})`
	)

	lines.push(
		!environment.present.read
			? `.env: unread (${environment.present.reason}); pass ${environment.flag} to node`
			: environment.present.value
				? `.env: present at ${environment.path}`
				: `.env: absent at ${environment.path}; @mailwoman/core/env reads ${environment.resolved ?? "no file"} there; ${environment.flag} names the calling checkout's file`
	)

	return lines
}
