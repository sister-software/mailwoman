import { describe, expect, it } from "vitest"

import { FORK_ORG, repoURL, upstreamOrgOf, wofRepoOrigin } from "#tools/pipeline/wof/repo-origin"

describe("wofRepoOrigin", () => {
	it("fetches every country repository from our fork and keeps whosonfirst-data as upstream", () => {
		expect(wofRepoOrigin("whosonfirst-data-admin-gb")).toEqual({
			repo: "whosonfirst-data-admin-gb",
			forkURL: "ssh://git@github.com/mailwoman/whosonfirst-data-admin-gb",
			upstreamOrg: "whosonfirst-data",
			upstreamURL: "ssh://git@github.com/whosonfirst-data/whosonfirst-data-admin-gb",
		})
	})

	it("gives the placetypes repository its upstream in the whosonfirst organization", () => {
		expect(upstreamOrgOf("whosonfirst-placetypes")).toBe("whosonfirst")

		expect(wofRepoOrigin("whosonfirst-placetypes").upstreamURL).toBe(
			"ssh://git@github.com/whosonfirst/whosonfirst-placetypes"
		)

		expect(wofRepoOrigin("whosonfirst-placetypes").forkURL).toBe(repoURL(FORK_ORG, "whosonfirst-placetypes"))
	})

	it("treats a postcode repository the same way as an admin repository", () => {
		const origin = wofRepoOrigin("whosonfirst-data-postalcode-us")

		expect(origin.forkURL).toBe(repoURL(FORK_ORG, "whosonfirst-data-postalcode-us"))
		expect(origin.upstreamOrg).toBe("whosonfirst-data")
	})
})
