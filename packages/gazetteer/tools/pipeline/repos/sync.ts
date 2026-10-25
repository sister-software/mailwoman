/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Clone and refresh the WOF repos root through {@link resolveWOFRepoOrigin}, so a machine cannot
 *   rebuild from upstream without a warning over a correction we depend on.
 *
 *   Split into a pure planner and an executor, so every refusal can be tested without a network or a
 *   clone.
 *
 *   It preserves remote configuration. It leaves dirty trees and local commits intact.
 *   It preserves shallow clone depth.
 *   The plan records the shallowness because a shallow
 *   checkout has no history to diff against.
 */

import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { makeDirectories } from "@mailwoman/core/fs/writers"
import { GitClient } from "@mailwoman/core/git"
import { dirname, type PathBuilderLike } from "path-ts"

import { type ForkProbe, type RepoOrigin, resolveWOFRepoOrigin } from "#tools/pipeline/wof/repo-origin"

/**
 * What the sync would do to one repo.
 *
 * Every value except {@link SyncAction.Clone} and {@link SyncAction.FastForward}
 * leaves the working tree untouched.
 */
export const SyncAction = {
	/**
	 * No checkout at this path — fetch it fresh from the resolved origin.
	 */
	Clone: "clone",
	/**
	 * Behind its remote, and a fast-forward reaches the remote's tip.
	 */
	FastForward: "fast-forward",
	/**
	 * Already at the remote's tip.
	 */
	UpToDate: "up-to-date",
	/**
	 * The clone's `origin` is not the resolved origin — typically upstream while a fork exists.
	 *
	 * Reported, never acted on without an explicit opt-in, because it changes what the next build reads.
	 */
	RepointRequired: "repoint-required",
	/**
	 * Uncommitted changes present.
	 */
	RefuseDirty: "refuse-dirty",
	/**
	 * Commits present that the remote does not have — unpushed work.
	 */
	RefuseLocalCommits: "refuse-local-commits",
	/**
	 * A directory exists but is not a git checkout — an extracted archive
	 * rather than something to fetch into.
	 */
	RefuseNotAClone: "refuse-not-a-clone",
} as const

export type SyncAction = (typeof SyncAction)[keyof typeof SyncAction]

/**
 * The observable state of one checkout.
 *
 * `null` means the checkout could not answer the question.
 * A negative answer has a known value.
 */
export interface CloneState {
	exists: boolean
	isRepository: boolean
	/**
	 * `origin`'s fetch URL, or `null` when the remote is absent.
	 */
	originURL: string | null
	dirty: boolean | null
	/**
	 * Commits on head that the tracked upstream lacks.
	 *
	 * `null` when no upstream is tracked.
	 */
	ahead: number | null
	behind: number | null
	shallow: boolean | null
	head: string | null
	/**
	 * Committer date of head, ISO-8601 — the vintage a build step cannot otherwise see.
	 */
	headDate: string | null
}

export interface RepoSyncPlan {
	repo: string
	directory: string
	origin: RepoOrigin
	state: CloneState
	action: SyncAction
	/**
	 * Why this action, in one sentence a build log can print.
	 */
	reason: string
}

/**
 * Two remote URLs naming the same repository.
 *
 * GitHub is reachable as `ssh://git@github.com/org/repo`, `git@github.com:org/repo`
 * and `https://github.com/org/repo`, with or without a `.git` suffix.
 * A string comparison would report a spurious re-point for a clone that is already correct.
 */
export function sameRemote(a: string | null, b: string | null): boolean {
	if (!a || !b) return false

	const normalize = (url: string): string =>
		url
			.replace(/^ssh:\/\/git@/, "")
			.replace(/^https?:\/\//, "")
			.replace(/^git@/, "")
			.replace(":", "/")
			.replace(/\.git$/, "")
			.replace(/\/+$/, "")
			.toLowerCase()

	return normalize(a) === normalize(b)
}

/**
 * Decide what to do with one repo.
 * Pure, every input is already measured.
 *
 * Order encodes the priority: refusals come before the re-point question, because reporting
 * a dirty tree as a re-point candidate would invite the action that loses the work.
 */
export function planRepoSync(origin: RepoOrigin, directory: string, state: CloneState): RepoSyncPlan {
	const plan = (action: SyncAction, reason: string): RepoSyncPlan => ({
		repo: origin.repo,
		directory,
		origin,
		state,
		action,
		reason,
	})

	if (!state.exists) return plan(SyncAction.Clone, `no checkout at ${directory} — clone from ${origin.source}`)

	if (!state.isRepository) {
		return plan(SyncAction.RefuseNotAClone, `${directory} exists but carries no git metadata — not fetched into`)
	}

	if (state.dirty) return plan(SyncAction.RefuseDirty, `${directory} has uncommitted changes — left untouched`)

	if ((state.ahead ?? 0) > 0) {
		return plan(
			SyncAction.RefuseLocalCommits,
			`${state.ahead} commit(s) not on the remote — push or drop them before syncing`
		)
	}

	if (!sameRemote(state.originURL ?? null, origin.url)) {
		return plan(
			SyncAction.RepointRequired,
			`origin is ${state.originURL ?? "absent"} but ${origin.source} is ${origin.url} — ${origin.reason}`
		)
	}

	if ((state.behind ?? 0) > 0) return plan(SyncAction.FastForward, `${state.behind} commit(s) behind ${origin.source}`)

	return plan(SyncAction.UpToDate, `at the ${origin.source} tip`)
}

/**
 * Read one checkout's state.
 *
 * Each probe is independently guarded: a repo with no tracked upstream still reports its remote
 * and vintage, rather than collapsing to "unknown" because one question had no answer.
 */
const UNINSPECTED = {
	originURL: null,
	dirty: null,
	ahead: null,
	behind: null,
	shallow: null,
	head: null,
	headDate: null,
} as const satisfies Partial<CloneState>

export async function inspectClone(directory: string): Promise<CloneState> {
	if (!(await pathExists(directory))) return { exists: false, isRepository: false, ...UNINSPECTED }

	const client = new GitClient({ cwd: directory })

	try {
		await client.read(["rev-parse", "--git-dir"])
	} catch {
		return { exists: true, isRepository: false, ...UNINSPECTED }
	}

	const read = (args: string[]): Promise<string | null> => client.read(args).catch(() => null)

	// Compared against origin's branch rather than `@{u}`: `git remote rename origin upstream`
	// rewrites `branch.<name>.remote`.
	// After a re-point, the tracked upstream is the remote we moved away from.
	// A clone level with its fork would then report unpushed commits.
	const branch = await read(["rev-parse", "--abbrev-ref", "HEAD"])

	const counts =
		(branch && branch !== "HEAD"
			? await read(["rev-list", "--left-right", "--count", `HEAD...origin/${branch}`])
			: null) ??
		(await read(["rev-list", "--left-right", "--count", "HEAD...origin/HEAD"])) ??
		(await read(["rev-list", "--left-right", "--count", "HEAD...@{u}"]))

	const [ahead, behind] = counts ? counts.split(/\s+/).map(Number) : [null, null]

	return {
		exists: true,
		isRepository: true,
		originURL: await read(["remote", "get-url", "origin"]),
		dirty: (await read(["status", "--porcelain"])) !== "",
		ahead: ahead ?? null,
		behind: behind ?? null,
		shallow: (await read(["rev-parse", "--is-shallow-repository"])) === "true",
		head: await read(["rev-parse", "--short", "HEAD"]),
		headDate: await read(["log", "-1", "--format=%cI"]),
	}
}

/**
 * Plan the sync for a set of repos without touching anything.
 *
 * `fetchFirst` updates remote-tracking refs so `behind` is measured against the remote's actual tip.
 * A stale clone would appear up-to-date without that fetch.
 * It defaults on.
 */
export async function planReposSync(options: {
	repos: readonly string[]
	probe: ForkProbe
	directoryFor: (repo: string) => PathBuilderLike
	fetchFirst?: boolean
	/**
	 * Receives each git client the planner fetches through, so a caller can render its progress.
	 */
	watch?: (client: GitClient) => void
	signal?: AbortSignal
}): Promise<RepoSyncPlan[]> {
	const plans: RepoSyncPlan[] = []

	for (const repo of options.repos) {
		const origin = await resolveWOFRepoOrigin(repo, options.probe)
		const directory = options.directoryFor(repo).toString()

		if (options.fetchFirst !== false && (await pathExists(directory))) {
			await using client = new GitClient({ cwd: directory, signal: options.signal })

			options.watch?.(client)

			// Preserve clone depth.
			// A shallow clone keeps its depth.
			// A full clone keeps complete history.
			// An unreachable remote is reported through `behind: null` rather than aborting the whole sweep.
			// One dead remote must not hide the other repos' verdicts.
			await client.fetch("origin", { reject: false })
		}

		plans.push(planRepoSync(origin, directory, await inspectClone(directory)))
	}

	return plans
}

/**
 * Execute one plan: clone a missing repo, fast-forward a stale one, or, with `repoint`,
 * move a clone's `origin` onto the resolved fork.
 *
 * Answers the sentence a caller reports, or `null` for a plan that leaves the checkout as it is.
 * Disposal of `client` stops a clone or fetch in progress.
 */
export async function applyRepoSyncPlan(
	plan: RepoSyncPlan,
	options: { client: GitClient; repoint?: boolean }
): Promise<string | null> {
	const { client } = options
	const sentences: string[] = []

	if (plan.action === SyncAction.Clone) {
		await makeDirectories(dirname(plan.directory))
		await client.clone(plan.origin.url, plan.directory, { depth: 1 })

		sentences.push(`cloned ${plan.repo} from ${plan.origin.source}`)
	}

	if (plan.action === SyncAction.FastForward) {
		await client.read(["-C", plan.directory, "merge", "--ff-only", "origin/HEAD"])

		sentences.push(`fast-forwarded ${plan.repo}`)
	}

	const repointed = plan.action === SyncAction.RepointRequired && options.repoint

	if (repointed) {
		sentences.push(await repoint(plan, client))
	}

	// A refused or unrepointed plan leaves its checkout untouched, remotes included.
	const touchable =
		plan.action === SyncAction.Clone ||
		plan.action === SyncAction.FastForward ||
		plan.action === SyncAction.UpToDate ||
		repointed

	if (touchable) {
		const added = await ensureForkRemote(plan, client)

		if (added) {
			sentences.push(added)
		}
	}

	return sentences.length ? sentences.join("; ") : null
}

/**
 * The remote name a clone gives our fork when its `origin` is upstream.
 */
export const FORK_REMOTE = "fork"

/**
 * Adds or corrects the `fork` remote of a clone whose fork exists.
 *
 * A clone made from upstream otherwise has no remote to push a correction to,
 * and the correction then reaches neither the fork nor an upstream PR.
 * A clone whose `origin` is the fork needs no second remote.
 *
 * @returns The sentence a caller reports, or `null` when the remote was already right.
 */
async function ensureForkRemote(plan: RepoSyncPlan, client: GitClient): Promise<string | null> {
	const forkURL = plan.origin.forkURL

	if (!forkURL || sameRemote(plan.origin.url, forkURL)) return null

	const current = await client.read(["-C", plan.directory, "remote", "get-url", FORK_REMOTE]).catch(() => null)

	if (sameRemote(current, forkURL)) return null

	await client.read(["-C", plan.directory, "remote", current ? "set-url" : "add", FORK_REMOTE, forkURL])

	return `${current ? "re-pointed" : "added"} the ${FORK_REMOTE} remote of ${plan.repo} at ${forkURL}`
}

/**
 * Moves a clone's `origin` onto the resolved fork and keeps the previous remote as `upstream`.
 */
async function repoint(plan: RepoSyncPlan, client: GitClient): Promise<string> {
	// The next upstream sync would need a guess without the fork's address.
	await client.read(["-C", plan.directory, "remote", "rename", "origin", "upstream"])
	await client.read(["-C", plan.directory, "remote", "add", "origin", plan.origin.url])
	await client.start(["-C", plan.directory, "fetch", "--progress", "origin"]).result

	// The rename preserved `branch.<name>.remote`, so without re-pointing tracking the next
	// `git pull` here pulls upstream over the corrections this command preserves.
	const branch = await client.read(["-C", plan.directory, "rev-parse", "--abbrev-ref", "HEAD"])

	if (branch && branch !== "HEAD") {
		await client.read(["-C", plan.directory, "branch", `--set-upstream-to=origin/${branch}`, branch])
	}

	return `re-pointed ${plan.repo} at ${plan.origin.org} (previous remote kept as upstream)`
}

/**
 * The one sentence a caller relays.
 */
export function syncSentence(plans: readonly RepoSyncPlan[]): string {
	const count = (action: SyncAction) => plans.filter((p) => p.action === action).length
	const refused = plans.filter((p) => p.action.startsWith("refuse")).length
	const forks = plans.filter((p) => p.origin.source === "fork").length
	const blind = plans.filter((p) => p.origin.reason.includes("fork lookup failed")).length

	return (
		`${plans.length} repo(s): ${count(SyncAction.UpToDate)} up to date, ${count(SyncAction.FastForward)} behind, ` +
		`${count(SyncAction.Clone)} missing, ${count(SyncAction.RepointRequired)} pointed elsewhere, ${refused} refused` +
		`; ${forks} resolved to our fork` +
		(blind ? `; ${blind} could NOT be checked for a fork — upstream assumed, which is not evidence` : "")
	)
}
