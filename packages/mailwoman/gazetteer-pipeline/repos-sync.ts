/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Clone and refresh the WOF repos root through {@link resolveWOFRepoOrigin}, so a machine cannot quietly rebuild from
 *   upstream over a correction we depend on.
 *
 *   `repos-audit` reports what IS on disk and `wof-repo-origin` answers where a repo SHOULD come from. Nothing joined
 *   them, so the join happened by hand — and a hand-run clone is how the fork gets bypassed: the pull succeeds, the
 *   build succeeds, and the artifact silently loses every record the fork corrects. THE DIRECTORY IS THE RECIPE
 *   (`repos-audit`'s docstring explains why), so what lands here decides what the next build believes.
 *
 *   Split into a PURE PLANNER and an executor. Every refusal below is a decision about someone's working tree, and a
 *   decision worth making is worth testing without a network or a 2 GB clone.
 *
 *   Three things it will not do, each for a reason that has already cost something:
 *
 *   - **Never re-point a remote silently.** Changing `origin` changes what the next build ingests. A checkout aimed at
 *       upstream while a fork exists is REPORTED, and re-pointing is a separate opt-in.
 *   - **Never touch a dirty tree or a clone carrying local commits.** Corrections are authored in these directories
 *       before they are pushed; a helpful `git reset` here destroys work that exists nowhere else.
 *   - **Never force a shallow clone forward.** Every WOF checkout in the lab is `--depth 1`, which is not merely small:
 *       `git show <commit> --name-status` on one reports every file as `A`, so a diff against it reads as "this commit
 *       added 72,679 files". The plan carries the shallowness so a reader knows the history they are about to consult
 *       is not there.
 */

import { execFileSync } from "@mailwoman/platform/child_process"
import { existsSync } from "@mailwoman/platform/fs"

import { type ForkProbe, type RepoOrigin, resolveWOFRepoOrigin } from "./wof-repo-origin.ts"

/**
 * What the sync would do to one repo. Every value except {@link SyncAction.Clone} and {@link SyncAction.FastForward}
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
	 * The clone's `origin` is not the resolved origin — typically upstream while a fork exists. Reported, never acted on
	 * without an explicit opt-in, because it changes what the next build reads.
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
	 * A directory exists but is not a git checkout — an extracted archive, not something to fetch into.
	 */
	RefuseNotAClone: "refuse-not-a-clone",
} as const

export type SyncAction = (typeof SyncAction)[keyof typeof SyncAction]

/**
 * The observable state of one checkout. Every field is read, never inferred — `undefined` means the question could not
 * be answered here, which is different from a negative answer.
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
	 * Commits on HEAD that the tracked upstream lacks. `undefined` when no upstream is tracked.
	 */
	ahead?: number
	behind?: number
	shallow?: boolean
	head?: string
	/**
	 * Committer date of HEAD, ISO-8601 — the vintage a build step cannot otherwise see.
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
 * GitHub is reachable as `ssh://git@github.com/org/repo`, `git@github.com:org/repo` and `https://github.com/org/repo`,
 * with or without a `.git` suffix. Comparing the strings would report a re-point for a clone that is already correct,
 * and a spurious re-point prompt trains a reader to approve them.
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
 * Decide what to do with one repo. Pure: every input is already measured.
 *
 * Order matters and encodes the priority. Refusals come FIRST, before the re-point question — a dirty tree is a reason
 * to touch nothing at all, and reporting it as a re-point candidate would invite exactly the action that loses the
 * work.
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
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim()
}

/**
 * Read one checkout's state. Each probe is independently guarded: a repo with no tracked upstream still reports its
 * remote and vintage, rather than collapsing to "unknown" because one question had no answer.
 */
export function inspectClone(directory: string): CloneState {
	if (!existsSync(directory)) return { exists: false, isRepository: false }

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

	// Compared against ORIGIN's branch, not `@{u}`. `git remote rename origin upstream` rewrites `branch.<name>.remote`,
	// so after a re-point the tracked upstream is the remote we moved AWAY from — and a clone sitting exactly level with
	// its fork reports as carrying unpushed commits, which the planner then refuses to touch. Measured on the GB
	// checkout the moment the re-point landed: `HEAD...@{u}` answered `35 0` while `HEAD` and `origin/master` were the
	// same sha.
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
 * `fetchFirst` updates remote-tracking refs so `behind` is measured against the remote's ACTUAL tip rather than
 * whatever this machine last heard. Skipping it reports a stale clone as up-to-date, which is the failure the whole
 * command exists to prevent — so it defaults ON, and turning it off is for offline inspection.
 */
export async function planReposSync(options: {
	root: string
	repos: readonly string[]
	probe: ForkProbe
	directoryFor: (repo: string) => string
	fetchFirst?: boolean
}): Promise<RepoSyncPlan[]> {
	const plans: RepoSyncPlan[] = []

	for (const repo of options.repos) {
		const origin = await resolveWOFRepoOrigin(repo, options.probe)
		const directory = options.directoryFor(repo)

		if (options.fetchFirst !== false && existsSync(directory)) {
			try {
				// Depth-preserving: a shallow clone stays shallow, and an unshallow one is not truncated.
				git(directory, ["fetch", "--quiet", "origin"])
			} catch {
				// An unreachable remote is a state the plan reports through `behind: undefined`, not a reason to abort the
				// whole sweep — one dead remote must not hide the other twelve repos' verdicts.
			}
		}

		plans.push(planRepoSync(origin, directory, inspectClone(directory)))
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
