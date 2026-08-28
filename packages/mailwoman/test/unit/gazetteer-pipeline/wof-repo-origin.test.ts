/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for the fork-preference resolver.
 *
 *   Two legs are required. A CLEAN fork must resolve UPSTREAM — after the 2026-08-20 sweep forked 474 repos,
 *   existence stopped meaning "we corrected this", and a fork does not track its parent, so preferring a clean one
 *   reads a stale snapshot for no benefit. And a FAILED probe must pull upstream while SAYING the lookup failed,
 *   because "no fork" and "could not look" license different conclusions.
 */

import {
	FORK_ORG,
	type ForkState,
	resolveWOFRepoOrigin,
	UPSTREAM_ORG,
} from "mailwoman/gazetteer-pipeline/wof-repo-origin"
import { describe, expect, it } from "vitest"

const states: Record<string, ForkState> = {
	"whosonfirst-data-admin-gb": "diverged", // carries the 35 January-2019 corrections
	"whosonfirst-data-admin-fr": "clean", // forked by the sweep, no commits of ours
}

const probe = async (org: string, repo: string): Promise<ForkState> =>
	org === FORK_ORG ? (states[repo] ?? "absent") : "absent"

describe("resolveWOFRepoOrigin", () => {
	it("prefers our fork when it carries commits upstream does not", async () => {
		const origin = await resolveWOFRepoOrigin("whosonfirst-data-admin-gb", probe)

		expect(origin).toMatchObject({ org: FORK_ORG, source: "fork" })
		expect(origin.url).toBe("ssh://git@github.com/mailwoman/whosonfirst-data-admin-gb")
		expect(origin.reason).toContain("carries commits upstream does not")
	})

	it("sends a CLEAN fork to upstream — existence is not correction, and a fork does not track its parent", async () => {
		const origin = await resolveWOFRepoOrigin("whosonfirst-data-admin-fr", probe)

		expect(origin).toMatchObject({ org: UPSTREAM_ORG, source: "upstream" })
		expect(origin.reason).toContain("carries nothing upstream lacks")
		expect(origin.reason).toContain("does not track its parent")
	})

	it("falls back to upstream when no fork exists, and says so", async () => {
		const origin = await resolveWOFRepoOrigin("whosonfirst-data-admin-zz", probe)

		expect(origin).toMatchObject({ org: UPSTREAM_ORG, source: "upstream" })
		expect(origin.reason).toContain("no mailwoman/whosonfirst-data-admin-zz fork")
	})

	it("reads a FAILED probe as upstream-with-a-caveat, never as proof about the fork", async () => {
		const origin = await resolveWOFRepoOrigin("whosonfirst-data-admin-gb", async () => {
			throw new Error("gh: not authenticated")
		})

		expect(origin.source).toBe("upstream")
		expect(origin.reason).toContain("fork lookup failed")
		expect(origin.reason).toContain("NOT evidence")
	})

	it("distinguishes the three upstream reasons, so a log says WHICH one happened", async () => {
		const clean = await resolveWOFRepoOrigin("whosonfirst-data-admin-fr", probe)
		const absent = await resolveWOFRepoOrigin("whosonfirst-data-admin-zz", probe)

		const failed = await resolveWOFRepoOrigin("whosonfirst-data-admin-gb", async () => {
			throw new Error("boom")
		})

		expect(new Set([clean.reason, absent.reason, failed.reason]).size).toBe(3)
	})
})
