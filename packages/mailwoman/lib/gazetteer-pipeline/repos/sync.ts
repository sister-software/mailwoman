/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Clone and refresh the WOF repos root through {@link resolveWOFRepoOrigin}, so a machine cannot
 *   quietly rebuild from upstream over a correction we depend on.
 *
 *   Split into a pure planner and an executor, so every refusal can be tested without a network or a
 *   clone.
 *
 *   It never re-points a remote silently, never touches a dirty tree or one carrying local commits,
 *   and never forces a shallow clone forward. The plan carries the shallowness because a shallow
 *   checkout has no history to diff against.
 */

import { pathExists } from "@mailwoman/core/fs/readers"
import { runFileSync } from "@mailwoman/core/process"
import type { PathBuilderLike } from "path-ts"

import { type ForkProbe, type RepoOrigin, resolveWOFRepoOrigin } from "#gazetteer-pipeline/wof/repo-origin"

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
	 * Behind its remote and cleanly advanceable.
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
 * `undefined` means the question could not be answered here, which is different from a negative answer.
 */
export interface CloneState {
	exists: boolean
	isRepository: boolean
	/**
	 * `origin`'s fetch URL, or `undefined` when the remote is absent.
	 */
	originURL?: string
	dirty?: boolean
	/**
	 * Commits on head that the tracked upstream lacks.
	 *
	 * `undefined` when no upstream is tracked.
	 */
	ahead?: number
	behind?: number
	shallow?: boolean
	head?: string
	/**
	 * Committer date of head, ISO-8601 — the vintage a build step cannot otherwise see.
	 */
	headDate?: string
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
export function sameRemote(a: string | undefined, b: string | undefined): boolean {
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

	if (!sameRemote(state.originURL, origin.url)) {
		return plan(
			SyncAction.RepointRequired,
			`origin is ${state.originURL ?? "absent"} but ${origin.source} is ${origin.url} — ${origin.reason}`
		)
	}

	if ((state.behind ?? 0) > 0) return plan(SyncAction.FastForward, `${state.behind} commit(s) behind ${origin.source}`)

	return plan(SyncAction.UpToDate, `at the ${origin.source} tip`)
}

function git(cwd: string, args: string[]): string {
	return runFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim()
}

/**
 * Read one checkout's state.
 *
 * Each probe is independently guarded: a repo with no tracked upstream still reports its remote
 * and vintage, rather than collapsing to "unknown" because one question had no answer.
 */
export async function inspectClone(directory: string): Promise<CloneState> {
	if (!(await pathExists(directory))) return { exists: false, isRepository: false }

	try {
		git(directory, ["rev-parse", "--git-dir"])
	} catch {
		return { exists: true, isRepository: false }
	}

	const read = (args: string[]): string | undefined => {
		try {
			return git(directory, args)
		} catch {
			return undefined
		}
	}

	// Compared against origin's branch rather than `@{u}`: `git remote rename origin upstream`
	// rewrites `branch.<name>.remote`, so after a re-point the tracked upstream is the remote we
	// moved away from, and a clone level with its fork would report as carrying unpushed commits.
	const branch = read(["rev-parse", "--abbrev-ref", "HEAD"])

	const counts =
		(branch && branch !== "HEAD"
			? read(["rev-list", "--left-right", "--count", `HEAD...origin/${branch}`])
			: undefined) ??
		read(["rev-list", "--left-right", "--count", "HEAD...origin/HEAD"]) ??
		read(["rev-list", "--left-right", "--count", "HEAD...@{u}"])

	const [ahead, behind] = counts ? counts.split(/\s+/).map(Number) : [undefined, undefined]

	return {
		exists: true,
		isRepository: true,
		originURL: read(["remote", "get-url", "origin"]),
		dirty: read(["status", "--porcelain"]) !== "",
		...(ahead === undefined ? {} : { ahead }),
		...(behind === undefined ? {} : { behind }),
		shallow: read(["rev-parse", "--is-shallow-repository"]) === "true",
		head: read(["rev-parse", "--short", "HEAD"]),
		headDate: read(["log", "-1", "--format=%cI"]),
	}
}

/**
 * Plan the sync for a set of repos without touching anything.
 *
 * `fetchFirst` updates remote-tracking refs so `behind` is measured against the remote's actual tip.
 * Skipping it would report a stale clone as up-to-date.
 * It defaults on.
 */
export async function planReposSync(options: {
	repos: readonly string[]
	probe: ForkProbe
	directoryFor: (repo: string) => PathBuilderLike
	fetchFirst?: boolean
}): Promise<RepoSyncPlan[]> {
	const plans: RepoSyncPlan[] = []

	for (const repo of options.repos) {
		const origin = await resolveWOFRepoOrigin(repo, options.probe)
		const directory = options.directoryFor(repo).toString()

		if (options.fetchFirst !== false && (await pathExists(directory))) {
			try {
				// Depth-preserving: a shallow clone stays shallow, and an unshallow one is not truncated.
				git(directory, ["fetch", "--quiet", "origin"])
			} catch {
				// An unreachable remote is reported through `behind: undefined`
				// rather than aborting the whole sweep.
				// One dead remote must not hide the other repos' verdicts.
			}
		}

		plans.push(planRepoSync(origin, directory, await inspectClone(directory)))
	}

	return plans
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
