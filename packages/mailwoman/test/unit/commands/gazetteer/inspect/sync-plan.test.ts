import {
	assertDestinationNotARepoName,
	countryRepoNames,
	selectRepos,
	type DiscoveredRepo,
} from "mailwoman/commands/gazetteer/inspect/sync-plan"
import { describe, expect, it } from "vitest"

const url = (name: string) => `https://github.com/whosonfirst-data/${name}`

const DISCOVERED: readonly DiscoveredRepo[] = [
	{ name: "whosonfirst-data-admin-tr", url: url("whosonfirst-data-admin-tr"), diskUsageKB: 74_752 },
	{ name: "whosonfirst-data-postalcode-tr", url: url("whosonfirst-data-postalcode-tr"), diskUsageKB: 6144 },
	{ name: "whosonfirst-data-admin-fr", url: url("whosonfirst-data-admin-fr"), diskUsageKB: 235_000 },
	{ name: "whosonfirst-data-venue-tr", url: url("whosonfirst-data-venue-tr"), diskUsageKB: 75_776 },
]

describe("assertDestinationNotARepoName", () => {
	it("refuses a repository name in the destination slot", () => {
		expect(() => assertDestinationNotARepoName("whosonfirst-data-admin-tr")).toThrow(/--repos/)
	})

	it("names the flag that was meant, with the repository the caller typed", () => {
		expect(() => assertDestinationNotARepoName("whosonfirst-data-postalcode-tr")).toThrow(
			/--repos whosonfirst-data-postalcode-tr/
		)
	})

	it("accepts a real destination", () => {
		for (const destination of ["/srv/mailwoman-data/wof/repos", "./repos", "../wof/repos"]) {
			expect(() => assertDestinationNotARepoName(destination), destination).not.toThrow()
		}
	})
})

describe("countryRepoNames", () => {
	it("expands an ISO code to the admin and postalcode repositories", () => {
		expect(countryRepoNames("tr")).toEqual(["whosonfirst-data-admin-tr", "whosonfirst-data-postalcode-tr"])
	})

	it("accepts a comma list in either case, trimming blanks", () => {
		expect(countryRepoNames(" TR , fr ,")).toEqual([
			"whosonfirst-data-admin-tr",
			"whosonfirst-data-postalcode-tr",
			"whosonfirst-data-admin-fr",
			"whosonfirst-data-postalcode-fr",
		])
	})

	it("is empty when the flag is absent", () => {
		expect(countryRepoNames(undefined)).toEqual([])
	})
})

describe("selectRepos", () => {
	it("selects the named repositories", () => {
		const selection = selectRepos(DISCOVERED, { repos: "whosonfirst-data-admin-tr" })

		expect(selection.selected.map((entry) => entry.name)).toEqual(["whosonfirst-data-admin-tr"])
	})

	it("refuses a name that matched nothing, and suggests the near miss", () => {
		expect(() => selectRepos(DISCOVERED, { repos: "whosonfirst-data-admin-turkey" })).toThrow(
			/whosonfirst-data-admin-tr/
		)
	})

	it("points a country name at the country flag, which a near miss cannot", () => {
		expect(() => selectRepos(DISCOVERED, { repos: "whosonfirst-data-admin-turkey" })).toThrow(/--countries/)
	})

	it("refuses an unfiltered sync, stating the cost", () => {
		const call = () => selectRepos(DISCOVERED, {})

		expect(call).toThrow(/--all/)
		expect(call).toThrow(/4 repositories/)
	})

	it("syncs everything only when --all is explicit", () => {
		expect(selectRepos(DISCOVERED, { all: true }).selected).toHaveLength(DISCOVERED.length)
	})

	it("expands --countries to that country's admin and postalcode repositories", () => {
		const selection = selectRepos(DISCOVERED, { countries: "tr" })

		expect(selection.selected.map((entry) => entry.name)).toEqual([
			"whosonfirst-data-admin-tr",
			"whosonfirst-data-postalcode-tr",
		])
	})

	it("refuses a country the org does not carry", () => {
		expect(() => selectRepos(DISCOVERED, { countries: "zz" })).toThrow(/zz/)
	})

	it("reports the transfer size of the selection", () => {
		expect(selectRepos(DISCOVERED, { countries: "tr" }).totalDiskUsageKB).toBe(74_752 + 6144)
	})
})
