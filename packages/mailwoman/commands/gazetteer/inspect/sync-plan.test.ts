/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { assertDestinationNotARepoName, countryRepoNames, selectRepos, type DiscoveredRepo } from "./sync-plan.ts"

const url = (name: string) => `https://github.com/whosonfirst-data/${name}`

const DISCOVERED: readonly DiscoveredRepo[] = [
	{ name: "whosonfirst-data-admin-tr", url: url("whosonfirst-data-admin-tr"), diskUsageKB: 74_752 },
	{ name: "whosonfirst-data-postalcode-tr", url: url("whosonfirst-data-postalcode-tr"), diskUsageKB: 6144 },
	{ name: "whosonfirst-data-admin-fr", url: url("whosonfirst-data-admin-fr"), diskUsageKB: 235_000 },
	{ name: "whosonfirst-data-venue-tr", url: url("whosonfirst-data-venue-tr"), diskUsageKB: 75_776 },
]

describe("assertDestinationNotARepoName", () => {
	it("refuses a repository name in the destination slot", () => {
		// The trap that cost 65 GB: the name lands on the positional, which is the destination directory, so no
		// `--repos` filter is applied and the whole org syncs into a directory named after one repo.
		expect(() => assertDestinationNotARepoName("whosonfirst-data-admin-tr")).toThrow(/--repos/)
	})

	it("names the flag that was meant, with the repository the caller typed", () => {
		expect(() => assertDestinationNotARepoName("whosonfirst-data-postalcode-tr")).toThrow(
			/--repos whosonfirst-data-postalcode-tr/
		)
	})

	it("accepts a real destination", () => {
		for (const destination of ["/mnt/playpen/mailwoman-data/wof/repos", "./repos", "../wof/repos"]) {
			expect(() => assertDestinationNotARepoName(destination), destination).not.toThrow()
		}
	})
})

describe("countryRepoNames", () => {
	it("expands an ISO code to the admin and postalcode repositories", () => {
		expect(countryRepoNames("tr")).toEqual(["whosonfirst-data-admin-tr", "whosonfirst-data-postalcode-tr"])
	})

	it("accepts a comma list in either case, trimming blanks", () => {
		// `--countries` is the house spelling for a comma list (build candidate, release, postcode-intl); singular
		// `--country` means exactly one code elsewhere in the CLI.
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
		// Today an unmatched filter syncs only the placetypes repo and reports "1 of 1" — a typo reads as success.
		expect(() => selectRepos(DISCOVERED, { repos: "whosonfirst-data-admin-turkey" })).toThrow(
			/whosonfirst-data-admin-tr/
		)
	})

	it("points a country name at the country flag, which a near miss cannot", () => {
		// `-turkey` is nearer to a real `-tu` repository than to `-tr` by string distance, so the hint has to be stated
		// rather than inferred.
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

		// Venue is NOT included: no country in the data root has a venue clone, and it doubles the transfer.
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
