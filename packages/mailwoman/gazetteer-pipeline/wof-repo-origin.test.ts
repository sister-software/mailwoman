/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for the fork-preference resolver. The load-bearing leg is the FAILED probe: a machine that cannot reach
 *   GitHub must pull upstream AND say that its fork lookup failed, because "no fork" and "could not look" license
 *   different conclusions — silently reading upstream over a correction we depend on is the failure this guards.
 */

import { describe, expect, it } from "vitest"

import { FORK_ORG, resolveWOFRepoOrigin, UPSTREAM_ORG } from "./wof-repo-origin.ts"

const forked = new Set(["whosonfirst-data-admin-gb"])
const probe = async (org: string, repo: string) => org === FORK_ORG && forked.has(repo)

describe("resolveWOFRepoOrigin", () => {
	it("prefers our fork when one exists", async () => {
		const origin = await resolveWOFRepoOrigin("whosonfirst-data-admin-gb", probe)

		expect(origin).toMatchObject({ org: FORK_ORG, source: "fork" })
		expect(origin.url).toBe("ssh://git@github.com/mailwoman/whosonfirst-data-admin-gb")
	})

	it("falls back to upstream when no fork exists, and says so", async () => {
		const origin = await resolveWOFRepoOrigin("whosonfirst-data-admin-fr", probe)

		expect(origin).toMatchObject({ org: UPSTREAM_ORG, source: "upstream" })
		expect(origin.reason).toContain("no mailwoman/whosonfirst-data-admin-fr fork")
	})

	it("reads a FAILED probe as upstream-with-a-caveat, never as proof no fork exists", async () => {
		const origin = await resolveWOFRepoOrigin("whosonfirst-data-admin-gb", async () => {
			throw new Error("gh: not authenticated")
		})

		expect(origin.source).toBe("upstream")
		expect(origin.reason).toContain("fork lookup failed")
		expect(origin.reason).toContain("NOT evidence")
	})
})
