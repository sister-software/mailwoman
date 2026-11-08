/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for the repository sync. The refusals matter most: a sync that moves a clone with unpushed corrections to the
 *   fork's tip destroys the only copy, and the corrections are authored in these directories.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { GitClient, type GitProgress } from "@mailwoman/core/git"
import type { PathBuilder } from "path-ts"
import { describe, expect, it } from "vitest"

import {
	type CloneState,
	inspectClone,
	planRepoSync,
	Remote,
	remoteChanges,
	sameRemote,
	SyncAction,
	syncSentence,
	syncWOFRepo,
} from "#tools/pipeline/repos/sync"
import { type ForkHost, type ForkUpdate, type RepoOrigin, wofRepoOrigin } from "#tools/pipeline/wof/repo-origin"

const REPO = "whosonfirst-data-admin-gb"

const clone = (over: Partial<CloneState> = {}): CloneState => ({
	exists: true,
	isRepository: true,
	remotes: {},
	branch: "main",
	dirty: false,
	ahead: 0,
	behind: 0,
	shallow: true,
	head: "684c702d4",
	headDate: "2026-08-19T18:42:34+02:00",
	...over,
})

describe("sameRemote", () => {
	it("equates the URL forms GitHub answers to, so a correct clone is never re-pointed", () => {
		const forms = [
			"ssh://git@github.com/mailwoman/whosonfirst-data-admin-gb",
			"git@github.com:mailwoman/whosonfirst-data-admin-gb",
			"https://github.com/mailwoman/whosonfirst-data-admin-gb",
			"https://github.com/mailwoman/whosonfirst-data-admin-gb.git",
			"ssh://git@github.com/mailwoman/whosonfirst-data-admin-gb/",
		]

		for (const form of forms) {
			expect(sameRemote(form, forms[0]), form).toBe(true)
		}
	})

	it("separates the fork from upstream", () => {
		const origin = wofRepoOrigin(REPO)

		expect(sameRemote(origin.forkURL, origin.upstreamURL)).toBe(false)
	})

	it("treats an absent remote as not matching", () => {
		expect(sameRemote(null, wofRepoOrigin(REPO).forkURL)).toBe(false)
		expect(sameRemote(undefined, undefined)).toBe(false)
	})
})

describe("remoteChanges", () => {
	const origin = wofRepoOrigin(REPO)

	it("moves an upstream origin onto the fork, adds upstream, and removes the old fork remote", () => {
		expect(remoteChanges(origin, { origin: origin.upstreamURL, fork: origin.forkURL })).toEqual([
			{ kind: "set-url", remote: Remote.Origin, url: origin.forkURL },
			{ kind: "add", remote: Remote.Upstream, url: origin.upstreamURL },
			{ kind: "remove", remote: Remote.LegacyFork, url: origin.forkURL },
		])
	})

	it("changes nothing on a clone whose remotes are already right, in another URL form", () => {
		const remotes = {
			origin: "git@github.com:mailwoman/whosonfirst-data-admin-gb.git",
			upstream: "https://github.com/whosonfirst-data/whosonfirst-data-admin-gb",
		}

		expect(remoteChanges(origin, remotes)).toEqual([])
	})

	it("leaves a remote with another name alone", () => {
		expect(remoteChanges(origin, { origin: origin.forkURL, upstream: origin.upstreamURL, mine: "x" })).toEqual([])
	})
})

describe("planRepoSync", () => {
	it("refuses a dirty tree even when it is behind", () => {
		expect(planRepoSync(clone({ dirty: true, behind: 12 })).action).toBe(SyncAction.RefuseDirty)
	})

	it("refuses a clone carrying commits the fork lacks", () => {
		const plan = planRepoSync(clone({ ahead: 35, behind: 2 }))

		expect(plan.action).toBe(SyncAction.RefuseLocalCommits)
		expect(plan.reason).toContain("35 commit(s) the fork lacks")
	})

	it("clones what is absent and refuses a directory that is not a checkout", () => {
		expect(planRepoSync(clone({ exists: false, isRepository: false })).action).toBe(SyncAction.Clone)
		expect(planRepoSync(clone({ isRepository: false })).action).toBe(SyncAction.RefuseNotAClone)
	})

	it("fast-forwards a clean clone that is behind, and only then", () => {
		expect(planRepoSync(clone({ behind: 7 })).action).toBe(SyncAction.FastForward)
		expect(planRepoSync(clone()).action).toBe(SyncAction.UpToDate)
	})
})

/**
 * A {@link ForkHost} that records its calls and answers `update` for every fork.
 */
function recordingHost(update: ForkUpdate["kind"] = "none"): ForkHost & { calls: string[] } {
	const calls: string[] = []

	return {
		calls,
		async ensureFork(origin) {
			calls.push(`ensure ${origin.repo}`)

			return false
		},
		async updateFork(origin) {
			calls.push(`update ${origin.repo}`)

			return update === "conflict"
				? { kind: "conflict", branch: "main", message: "HTTP 409" }
				: { kind: update, branch: "main" }
		},
	}
}

async function commit(client: GitClient, directory: PathBuilder, file: string): Promise<void> {
	await writeLocalTextFile(`${file}\n`, directory(file))
	await client.read(["-C", directory.toString(), "add", file])

	await client.read([
		"-C",
		directory.toString(),
		"-c",
		"user.email=fixture@example.invalid",
		"-c",
		"user.name=Fixture",
		"commit",
		"-qm",
		file,
	])
}

/**
 * An upstream repository with one commit and a fork of it one commit ahead.
 */
async function forkedFixture(scratch: PathBuilder, client: GitClient): Promise<RepoOrigin> {
	const upstream = scratch("upstream")
	const fork = scratch("fork")

	await client.read(["init", "--quiet", "--initial-branch=main", upstream.toString()])
	await commit(client, upstream, "README")
	await client.read(["clone", "--quiet", upstream.toString(), fork.toString()])
	await commit(client, fork, "CORRECTION")

	return { repo: REPO, forkURL: `file://${fork}`, upstreamOrg: "upstream", upstreamURL: `file://${upstream}` }
}

describe("syncWOFRepo", () => {
	it("clones a missing repository from the fork, adds upstream, and reports transfer progress", async () => {
		await using scratch = await temporaryDirectory("repos-sync-clone-")
		await using client = new GitClient({ cwd: scratch.path })

		const origin = await forkedFixture(scratch.path, client)
		const host = recordingHost()
		const steps: GitProgress[] = []

		client.on("progress", (step) => steps.push(step))

		const result = await syncWOFRepo(REPO, { root: scratch.path("repos"), host, client, resolveOrigin: () => origin })

		expect(result.action).toBe(SyncAction.Clone)
		expect(result.directory).toBe(scratch.path("repos", REPO).toString())
		expect(host.calls).toEqual([`ensure ${REPO}`, `update ${REPO}`])
		expect(result.state.remotes).toEqual({ origin: origin.forkURL, upstream: origin.upstreamURL })
		expect(result.state.shallow).toBe(true)
		expect(steps.length).toBeGreaterThan(0)
	})

	it("re-points a clone of upstream at the fork and fast-forwards it to the fork's tip", async () => {
		await using scratch = await temporaryDirectory("repos-sync-repoint-")
		await using client = new GitClient({ cwd: scratch.path })

		const origin = await forkedFixture(scratch.path, client)
		const directory = scratch.path("repos", REPO)

		await client.read(["clone", "--quiet", origin.upstreamURL, directory.toString()])
		await client.read(["-C", directory.toString(), "remote", "add", "fork", origin.forkURL])

		const result = await syncWOFRepo(REPO, {
			root: scratch.path("repos"),
			host: recordingHost(),
			client,
			resolveOrigin: () => origin,
		})

		expect(result.action).toBe(SyncAction.FastForward)
		expect(result.state.remotes).toEqual({ origin: origin.forkURL, upstream: origin.upstreamURL })
		expect(result.state.behind).toBe(0)
		await expect(client.read(["-C", directory.toString(), "log", "-1", "--format=%s"])).resolves.toBe("CORRECTION")

		await expect(
			client.read(["-C", directory.toString(), "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])
		).resolves.toBe("origin/main")

		// The full clone of upstream plus the fork's correction held two commits.
		// Compaction leaves the tip only.
		expect(result.compacted).toEqual({ commitsBefore: 2, commitsAfter: 1, otherBranches: [] })

		await expect(client.read(["-C", directory.toString(), "rev-parse", "--is-shallow-repository"])).resolves.toBe(
			"true"
		)
	})

	it("fetches only the checked-out branch from the fork and reports a local branch that keeps history", async () => {
		await using scratch = await temporaryDirectory("repos-sync-branches-")
		await using client = new GitClient({ cwd: scratch.path })

		const origin = await forkedFixture(scratch.path, client)
		const fork = scratch.path("fork")
		const directory = scratch.path("repos", REPO)

		await client.read(["-C", fork.toString(), "branch", "topic"])
		await client.read(["clone", "--quiet", origin.forkURL, directory.toString()])
		await client.read(["-C", directory.toString(), "branch", "local-work", "HEAD~1"])
		await commit(client, fork, "LATER")

		const result = await syncWOFRepo(REPO, {
			root: scratch.path("repos"),
			host: recordingHost(),
			client,
			resolveOrigin: () => origin,
		})

		expect(result.action).toBe(SyncAction.FastForward)
		expect(result.compacted?.otherBranches).toEqual(["local-work"])

		// `origin/topic` is gone.
		// `origin/HEAD` is a symbolic ref to `origin/main` and holds no history.
		await expect(
			client.read(["-C", directory.toString(), "for-each-ref", "--format=%(refname)", "refs/remotes"])
		).resolves.toBe("refs/remotes/origin/HEAD\nrefs/remotes/origin/main")
	})

	it("re-points but leaves a clone with unpushed commits on its own commit", async () => {
		await using scratch = await temporaryDirectory("repos-sync-ahead-")
		await using client = new GitClient({ cwd: scratch.path })

		const origin = await forkedFixture(scratch.path, client)
		const directory = scratch.path("repos", REPO)

		await client.read(["clone", "--quiet", origin.upstreamURL, directory.toString()])
		await commit(client, directory, "UNPUSHED")

		const before = await client.read(["-C", directory.toString(), "rev-parse", "HEAD"])

		const result = await syncWOFRepo(REPO, {
			root: scratch.path("repos"),
			host: recordingHost(),
			client,
			resolveOrigin: () => origin,
		})

		expect(result.action).toBe(SyncAction.RefuseLocalCommits)
		expect(result.state.remotes["origin"]).toBe(origin.forkURL)
		await expect(client.read(["-C", directory.toString(), "rev-parse", "HEAD"])).resolves.toBe(before)
	})

	it("makes no GitHub request and leaves remotes and HEAD alone in a dry run, measuring against the fork", async () => {
		await using scratch = await temporaryDirectory("repos-sync-dry-")
		await using client = new GitClient({ cwd: scratch.path })

		const origin = await forkedFixture(scratch.path, client)
		const directory = scratch.path("repos", REPO)

		await client.read(["clone", "--quiet", origin.upstreamURL, directory.toString()])

		const head = await client.read(["-C", directory.toString(), "rev-parse", "HEAD"])

		const host = recordingHost()
		const options = { root: scratch.path("repos"), host, client, dryRun: true, resolveOrigin: () => origin }

		const existing = await syncWOFRepo(REPO, options)
		const missing = await syncWOFRepo(REPO, { ...options, root: scratch.path("elsewhere") })

		expect(host.calls).toEqual([])

		expect(existing.remoteChanges.map((change) => `${change.kind} ${change.remote}`)).toEqual([
			"set-url origin",
			"add upstream",
		])

		// The upstream clone is one commit behind the fork.
		// A comparison against the stale origin reports it level.
		expect(existing.action).toBe(SyncAction.FastForward)
		expect((await inspectClone(directory)).remotes).toEqual({ origin: origin.upstreamURL })
		await expect(client.read(["-C", directory.toString(), "rev-parse", "HEAD"])).resolves.toBe(head)
		expect(missing.action).toBe(SyncAction.Clone)
		expect((await inspectClone(scratch.path("elsewhere", REPO))).exists).toBe(false)
		expect(syncSentence([existing, missing])).toContain("would be cloned")
	})

	it("reports a fork that conflicts with upstream in the sentence", async () => {
		await using scratch = await temporaryDirectory("repos-sync-conflict-")
		await using client = new GitClient({ cwd: scratch.path })

		const origin = await forkedFixture(scratch.path, client)

		const result = await syncWOFRepo(REPO, {
			root: scratch.path("repos"),
			host: recordingHost("conflict"),
			client,
			resolveOrigin: () => origin,
		})

		expect(result.forkUpdate).toMatchObject({ kind: "conflict" })
		expect(syncSentence([result])).toContain("1 fork(s) conflict with upstream")
	})
})
