/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for the sync planner. The planner is where every decision about someone's working tree is made, so these pin
 *   the REFUSALS above all — a plan that fast-forwards over unpushed corrections destroys the only copy, and the whole
 *   reason the fork exists is that corrections are authored in these directories.
 */

import { describe, expect, it } from "vitest"

import { type CloneState, planRepoSync, sameRemote, SyncAction, syncSentence } from "./repos-sync.ts"
import { FORK_ORG, repoURL, UPSTREAM_ORG } from "./wof-repo-origin.ts"

const REPO = "whosonfirst-data-admin-gb"
const DIR = `/repos/${REPO}`

const forkOrigin = {
	repo: REPO,
	org: FORK_ORG,
	url: repoURL(FORK_ORG, REPO),
	source: "fork" as const,
	reason: "fork exists",
}

const upstreamOrigin = {
	repo: REPO,
	org: UPSTREAM_ORG,
	url: repoURL(UPSTREAM_ORG, REPO),
	source: "upstream" as const,
	reason: "no fork",
}

const clone = (over: Partial<CloneState> = {}): CloneState => ({
	exists: true,
	isRepository: true,
	originURL: repoURL(FORK_ORG, REPO),
	dirty: false,
	ahead: 0,
	behind: 0,
	shallow: true,
	head: "684c702d4",
	headDate: "2026-08-19T18:42:34+02:00",
	...over,
})

describe("sameRemote", () => {
	it("equates the URL forms GitHub answers to, so a correct clone is never reported as needing a re-point", () => {
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

	it("separates the fork from upstream — the one comparison that must not be fuzzy", () => {
		expect(sameRemote(repoURL(FORK_ORG, REPO), repoURL(UPSTREAM_ORG, REPO))).toBe(false)
	})

	it("treats an absent remote as not-matching rather than as a match against undefined", () => {
		expect(sameRemote(undefined, repoURL(FORK_ORG, REPO))).toBe(false)
		expect(sameRemote(undefined, undefined)).toBe(false)
	})
})

describe("planRepoSync", () => {
	it("refuses a dirty tree even when the remote is right and the clone is behind", () => {
		const plan = planRepoSync(forkOrigin, DIR, clone({ dirty: true, behind: 12 }))

		expect(plan.action).toBe(SyncAction.RefuseDirty)
	})

	it("refuses a clone carrying unpushed commits — the corrections are authored here", () => {
		const plan = planRepoSync(forkOrigin, DIR, clone({ ahead: 35 }))

		expect(plan.action).toBe(SyncAction.RefuseLocalCommits)
		expect(plan.reason).toContain("35 commit(s) not on the remote")
	})

	it("ranks a refusal ABOVE a re-point, so a dirty upstream-pointed clone is never offered for re-pointing", () => {
		const plan = planRepoSync(forkOrigin, DIR, clone({ dirty: true, originURL: repoURL(UPSTREAM_ORG, REPO) }))

		expect(plan.action).toBe(SyncAction.RefuseDirty)
	})

	it("reports a fork-available clone still aimed at upstream, and does not call it a fetch", () => {
		const plan = planRepoSync(forkOrigin, DIR, clone({ originURL: repoURL(UPSTREAM_ORG, REPO), behind: 3 }))

		expect(plan.action).toBe(SyncAction.RepointRequired)
		expect(plan.reason).toContain(UPSTREAM_ORG)
		expect(plan.reason).toContain(FORK_ORG)
	})

	it("clones what is absent", () => {
		expect(planRepoSync(upstreamOrigin, DIR, { exists: false, isRepository: false }).action).toBe(SyncAction.Clone)
	})

	it("refuses a directory that is not a checkout rather than cloning over it", () => {
		expect(planRepoSync(upstreamOrigin, DIR, { exists: true, isRepository: false }).action).toBe(
			SyncAction.RefuseNotAClone
		)
	})

	it("fast-forwards a clean, correctly-pointed, behind clone — and only then", () => {
		expect(planRepoSync(forkOrigin, DIR, clone({ behind: 7 })).action).toBe(SyncAction.FastForward)
		expect(planRepoSync(forkOrigin, DIR, clone()).action).toBe(SyncAction.UpToDate)
	})

	it("does not refuse a clone that is level with its fork — the post-repoint state a naive @{u} read mistakes for unpushed work", () => {
		// What the GB checkout looked like the moment its remote was re-pointed: level with `origin`, 35 ahead of the
		// remote it was moved away from. Reading the latter refuses to sync a perfectly clean clone, permanently.
		expect(planRepoSync(forkOrigin, DIR, clone({ ahead: 0, behind: 0 })).action).toBe(SyncAction.UpToDate)
	})

	it("carries the vintage and the shallowness through, so a reader knows the history is not there", () => {
		const plan = planRepoSync(forkOrigin, DIR, clone())

		expect(plan.state.shallow).toBe(true)
		expect(plan.state.headDate).toBe("2026-08-19T18:42:34+02:00")
	})
})

describe("syncSentence", () => {
	it("names an unverifiable fork lookup as unverified, never as an absent fork", () => {
		const blind = {
			...upstreamOrigin,
			reason: "fork lookup failed (gh: not authenticated) — falling back to upstream, which is NOT evidence",
		}

		const sentence = syncSentence([planRepoSync(blind, DIR, clone({ originURL: repoURL(UPSTREAM_ORG, REPO) }))])

		expect(sentence).toContain("could NOT be checked for a fork")
	})

	it("stays silent about fork lookups when every one succeeded", () => {
		expect(syncSentence([planRepoSync(forkOrigin, DIR, clone())])).not.toContain("could NOT be checked")
	})
})
