/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Clone and refresh the Who's On First repositories root. Every repository is handled the same way:
 *
 *   1. The `mailwoman` fork is created on GitHub when it is missing.
 *   2. Upstream is merged into the fork on GitHub.
 *   3. A missing clone is cloned from the fork at depth 1, directly under the root.
 *   4. An existing clone's remotes are set to `origin` = the fork and `upstream` = the original. A leftover `fork`
 *      remote is removed.
 *   5. The clone fetches `origin` and fast-forwards when it is behind.
 *
 *   A clone with uncommitted changes or commits the fork lacks is fetched but left on its current commit. The
 *   corrections that reach the fork are authored in these directories, and a reset would lose the only copy.
 *
 *   The decisions are pure functions over measured state, so every refusal is testable without a network or a clone.
 */

import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { makeDirectories } from "@mailwoman/core/fs/writers"
import { GitClient } from "@mailwoman/core/git"
import { dirname, type PathBuilderLike } from "path-ts"

import { type ForkHost, type ForkUpdate, type RepoOrigin, wofRepoOrigin } from "#tools/pipeline/wof/repo-origin"
import { wofClonePath } from "#whosonfirst/extract-repo"

/**
 * What the sync did, or in a dry run would do, to one clone's working tree.
 */
export const SyncAction = {
	/**
	 * No checkout at this path.
	 * It is cloned from the fork.
	 */
	Clone: "clone",
	/**
	 * Behind the fork, and a fast-forward reaches the fork's tip.
	 */
	FastForward: "fast-forward",
	/**
	 * Already at the fork's tip.
	 */
	UpToDate: "up-to-date",
	/**
	 * Uncommitted changes present.
	 */
	RefuseDirty: "refuse-dirty",
	/**
	 * Commits present that the fork does not have: unpushed work.
	 */
	RefuseLocalCommits: "refuse-local-commits",
	/**
	 * A directory exists but is not a git checkout, such as an extracted archive.
	 */
	RefuseNotAClone: "refuse-not-a-clone",
} as const

export type SyncAction = (typeof SyncAction)[keyof typeof SyncAction]

/**
 * The remotes a clone has, by name.
 */
export const Remote = {
	Origin: "origin",
	Upstream: "upstream",
	/**
	 * The second remote earlier syncs added to a clone whose `origin` was upstream.
	 * The sync removes it.
	 */
	LegacyFork: "fork",
} as const

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
	 * Fetch URL per remote name.
	 */
	remotes: Record<string, string>
	branch: string | null
	dirty: boolean | null
	/**
	 * Commits on head that `origin`'s copy of the branch lacks.
	 *
	 * `null` when `origin` has no such branch.
	 */
	ahead: number | null
	behind: number | null
	shallow: boolean | null
	head: string | null
	/**
	 * Committer date of head, ISO-8601: the vintage a build step cannot otherwise see.
	 */
	headDate: string | null
}

/**
 * One change to a clone's remote configuration.
 */
export type RemoteChange =
	| { kind: "add" | "set-url"; remote: string; url: string }
	| { kind: "remove"; remote: string; url: string }

/**
 * The result of syncing one repository.
 */
export interface RepoSyncResult {
	repo: string
	directory: string
	origin: RepoOrigin
	action: SyncAction
	/**
	 * Why this action, in one sentence a build log can print.
	 */
	reason: string
	remoteChanges: RemoteChange[]
	/**
	 * Whether this sync created the fork on GitHub.
	 * A dry run makes no GitHub request and records `null`.
	 */
	forkCreated: boolean | null
	/**
	 * What merging upstream into the fork did.
	 * `null` in a dry run.
	 */
	forkUpdate: ForkUpdate | null
	state: CloneState
	dryRun: boolean
}

/**
 * Two remote URLs naming the same repository.
 *
 * GitHub is reachable as `ssh://git@github.com/org/repo`, `git@github.com:org/repo`
 * and `https://github.com/org/repo`, with or without a `.git` suffix.
 * A string comparison would rewrite a remote that is already correct.
 */
export function sameRemote(a: string | null | undefined, b: string | null | undefined): boolean {
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
 * The remote changes that give a clone `origin` = the fork and `upstream` = the original.
 *
 * A remote with any other name keeps its URL.
 */
export function remoteChanges(origin: RepoOrigin, remotes: Readonly<Record<string, string>>): RemoteChange[] {
	const changes: RemoteChange[] = []

	const want = (remote: string, url: string): void => {
		const current = remotes[remote]

		if (!current) {
			changes.push({ kind: "add", remote, url })
		} else if (!sameRemote(current, url)) {
			changes.push({ kind: "set-url", remote, url })
		}
	}

	want(Remote.Origin, origin.forkURL)
	want(Remote.Upstream, origin.upstreamURL)

	const legacy = remotes[Remote.LegacyFork]

	if (legacy) {
		changes.push({ kind: "remove", remote: Remote.LegacyFork, url: legacy })
	}

	return changes
}

/**
 * Decide what to do with one existing clone's working tree.
 * The state is measured against `origin` = the fork.
 *
 * Refusals come first: a dirty tree or unpushed commits block the fast-forward that would otherwise run.
 */
export function planRepoSync(state: CloneState): { action: SyncAction; reason: string } {
	if (!state.exists) return { action: SyncAction.Clone, reason: "no checkout; cloned from the fork" }

	if (!state.isRepository) {
		return { action: SyncAction.RefuseNotAClone, reason: "the directory carries no git metadata; left untouched" }
	}

	if (state.dirty) return { action: SyncAction.RefuseDirty, reason: "uncommitted changes; left on its commit" }

	if ((state.ahead ?? 0) > 0) {
		return {
			action: SyncAction.RefuseLocalCommits,
			reason: `${state.ahead} commit(s) the fork lacks; push them to the fork, then sync again`,
		}
	}

	if ((state.behind ?? 0) > 0) {
		return { action: SyncAction.FastForward, reason: `${state.behind} commit(s) behind the fork` }
	}

	return { action: SyncAction.UpToDate, reason: "at the fork's tip" }
}

const UNINSPECTED = {
	remotes: {},
	branch: null,
	dirty: null,
	ahead: null,
	behind: null,
	shallow: null,
	head: null,
	headDate: null,
} as const satisfies Partial<CloneState>

/**
 * Read one checkout's state.
 *
 * Each probe is independently guarded: a clone whose `origin` lacks its branch
 * still reports its remotes and vintage.
 *
 * @param compareRef The ref `ahead` and `behind` are counted against.
 * It defaults to `origin`'s copy of the branch.
 */
export async function inspectClone(directory: PathBuilderLike, compareRef?: string): Promise<CloneState> {
	if (!(await pathExists(directory))) return { exists: false, isRepository: false, ...UNINSPECTED }

	const client = new GitClient({ cwd: directory })

	try {
		await client.read(["rev-parse", "--git-dir"])
	} catch {
		return { exists: true, isRepository: false, ...UNINSPECTED }
	}

	const read = (args: string[]): Promise<string | null> => client.read(args).catch(() => null)
	const answer = <T>(question: Promise<T>): Promise<T | null> => question.catch(() => null)

	const remotes: Record<string, string> = {}

	for (const name of (await answer(client.readLines(["remote"]))) ?? []) {
		const url = await read(["remote", "get-url", name])

		if (url) {
			remotes[name] = url
		}
	}

	const rawBranch = await answer(client.currentBranch())
	const branch = rawBranch && rawBranch !== "HEAD" ? rawBranch : null
	const status = await answer(client.status())

	// Compared against `origin`'s copy of the branch rather than `@{u}`, which can
	// still name the remote a clone was moved away from.
	const counts = branch
		? await read(["rev-list", "--left-right", "--count", `HEAD...${compareRef ?? `${Remote.Origin}/${branch}`}`])
		: null

	const [ahead, behind] = counts ? counts.split(/\s+/).map(Number) : [null, null]

	return {
		exists: true,
		isRepository: true,
		remotes,
		branch,
		dirty: status ? status.length > 0 : null,
		ahead: ahead ?? null,
		behind: behind ?? null,
		shallow: (await read(["rev-parse", "--is-shallow-repository"])) === "true",
		head: await answer(client.head({ short: true })),
		headDate: await read(["log", "-1", "--format=%cI"]),
	}
}

/**
 * Options for {@link syncWOFRepo}.
 */
export interface SyncWOFRepoOptions {
	/**
	 * The repositories root: clones sit at `<root>/<name>`.
	 */
	root: PathBuilderLike
	host: ForkHost
	/**
	 * Runs every git command, so a caller can watch its progress events.
	 * Its disposal stops a transfer in progress.
	 */
	client: GitClient
	/**
	 * Reports what would happen without a GitHub request or a change to a clone's
	 * remotes, refs or working tree.
	 *
	 * An existing clone fetches its branch from the fork into `FETCH_HEAD`, git's scratch ref,
	 * so its state is measured against the fork's current tip.
	 * The fork's tip can still move when the real sync merges upstream into it.
	 */
	dryRun?: boolean
	/**
	 * The remotes for a repository.
	 * Tests pass local `file://` repositories here.
	 *
	 * @defaultValue {@link wofRepoOrigin}
	 */
	resolveOrigin?: (repo: string) => RepoOrigin
}

/**
 * Sync one repository: update its fork on GitHub, then clone it or bring its clone to the fork's tip.
 */
export async function syncWOFRepo(repo: string, options: SyncWOFRepoOptions): Promise<RepoSyncResult> {
	const { client, host } = options
	const dryRun = options.dryRun === true
	const origin = (options.resolveOrigin ?? wofRepoOrigin)(repo)
	const directory = wofClonePath(options.root, repo)

	const forkCreated = dryRun ? null : await host.ensureFork(origin)
	const forkUpdate = dryRun ? null : await host.updateFork(origin)

	// The plan defaults to the one the reported state implies.
	// A clone or fast-forward passes the plan it ran, because the state read afterward is up to date.
	const result = (state: CloneState, changes: RemoteChange[], plan = planRepoSync(state)): RepoSyncResult => ({
		repo,
		directory,
		origin,
		action: plan.action,
		reason: plan.reason,
		remoteChanges: changes,
		forkCreated,
		forkUpdate,
		state,
		dryRun,
	})

	const before = await inspectClone(directory)

	if (!before.exists) {
		if (dryRun) return result(before, [])

		await makeDirectories(dirname(directory))
		await client.clone(origin.forkURL, directory, { depth: 1 })
		await client.read(["-C", directory, "remote", "add", Remote.Upstream, origin.upstreamURL])

		return result(await inspectClone(directory), [], { action: SyncAction.Clone, reason: "cloned from the fork" })
	}

	if (!before.isRepository) return result(before, [])

	const changes = remoteChanges(origin, before.remotes)

	if (dryRun) {
		if (!before.branch) return result(before, changes)

		await client.start(["-C", directory, "fetch", "--progress", origin.forkURL, before.branch]).result

		return result(await inspectClone(directory, "FETCH_HEAD"), changes)
	}

	for (const change of changes) {
		const args =
			change.kind === "remove"
				? ["remote", "remove", change.remote]
				: ["remote", change.kind, change.remote, change.url]

		await client.read(["-C", directory, ...args])
	}

	await client.start(["-C", directory, "fetch", "--progress", Remote.Origin]).result

	if (before.branch) {
		await client.read(["-C", directory, "branch", `--set-upstream-to=${Remote.Origin}/${before.branch}`, before.branch])
	}

	const fetched = await inspectClone(directory)
	const plan = planRepoSync(fetched)

	if (plan.action !== SyncAction.FastForward || !fetched.branch) return result(fetched, changes)

	await client.read(["-C", directory, "merge", "--ff-only", `${Remote.Origin}/${fetched.branch}`])

	return result(await inspectClone(directory), changes, plan)
}

/**
 * The one sentence a caller relays.
 */
export function syncSentence(results: readonly RepoSyncResult[]): string {
	const count = (action: SyncAction) => results.filter((r) => r.action === action).length
	const refused = results.filter((r) => r.action.startsWith("refuse")).length
	const repointed = results.filter((r) => r.remoteChanges.some((c) => c.remote === Remote.Origin)).length
	const created = results.filter((r) => r.forkCreated).length
	const conflicts = results.filter((r) => r.forkUpdate?.kind === "conflict").length
	const verb = results.some((r) => r.dryRun) ? "would be " : ""

	return (
		`${results.length} repo(s): ${count(SyncAction.Clone)} ${verb}cloned, ${count(SyncAction.FastForward)} ${verb}fast-forwarded, ` +
		`${count(SyncAction.UpToDate)} up to date, ${refused} refused; ${repointed} ${verb}re-pointed at the fork` +
		(created ? `; ${created} fork(s) created` : "") +
		(conflicts ? `; ${conflicts} fork(s) conflict with upstream and need a merge by hand` : "")
	)
}
