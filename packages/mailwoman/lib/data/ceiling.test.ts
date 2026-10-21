/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { resolvePath } from "path-ts"
import { describe, expect, it } from "vitest"

import type { DataBundle } from "#data/bundles"
import { ceilingCandidate, coverageSentence, installedBundleNames, precisionCeiling } from "#data/ceiling"

const candidate: DataBundle = {
	name: "candidate",
	description: "the free admin gazetteer",
	artifacts: [
		{ remotePath: "gazetteer/x/candidate.db", localPath: "wof/candidate.db", md5Sidecar: false, approxBytes: 1 },
	],
	rights: { publishers: [], expression: "CC0-1.0", terms: [], conditions: [], unresolved: [] },
}

const gbStreets: DataBundle = {
	...candidate,
	name: "gb-streets",
	description: "GB street-level atlas tier",
	artifacts: [
		{ remotePath: "tiers/gb/gb-streets.db", localPath: "tiers/gb-streets.db", md5Sidecar: false, approxBytes: 1 },
	],
	access: "licensed",
	tier: "tier:gb-streets",
	countries: ["GB"],
}

const bundles = { candidate, "gb-streets": gbStreets }

describe("precisionCeiling", () => {
	it("states the uninstalled tier for a country it covers when the result resolved to an admin level", () => {
		expect(precisionCeiling({ resolution_tier: "admin", countryCode: "GB" }, new Set(["candidate"]), bundles)).toEqual({
			resolved: "admin",
			tier: "tier:gb-streets",
			command: "mailwoman data pull gb-streets",
		})

		expect(precisionCeiling({ resolution_tier: "postcode", countryCode: "GB" }, new Set(), bundles)).toMatchObject({
			tier: "tier:gb-streets",
		})
	})

	it("is null when the tier is installed, the country has no tier, the country is unknown, or the result is already fine", () => {
		expect(
			precisionCeiling({ resolution_tier: "admin", countryCode: "GB" }, new Set(["gb-streets"]), bundles)
		).toBeNull()

		expect(precisionCeiling({ resolution_tier: "admin", countryCode: "US" }, new Set(), bundles)).toBeNull()
		expect(precisionCeiling({ resolution_tier: "admin", countryCode: null }, new Set(), bundles)).toBeNull()
		expect(precisionCeiling({ resolution_tier: "street", countryCode: "GB" }, new Set(), bundles)).toBeNull()
		expect(precisionCeiling({ resolution_tier: "address_point", countryCode: "GB" }, new Set(), bundles)).toBeNull()
	})

	it("renders the sentence the CLI prints", () => {
		expect(
			coverageSentence({ resolved: "admin", tier: "tier:gb-streets", command: "mailwoman data pull gb-streets" })
		).toBe(
			"Resolved to admin. The tier:gb-streets tier covers this country and is not installed: mailwoman data pull gb-streets"
		)
	})
})

describe("ceilingCandidate", () => {
	it("picks the tiered bundle for the result's country before any disk is read, and nothing for a fine result", () => {
		expect(ceilingCandidate({ resolution_tier: "admin", countryCode: "GB" }, bundles)?.name).toBe("gb-streets")
		expect(ceilingCandidate({ resolution_tier: "street", countryCode: "GB" }, bundles)).toBeNull()
		expect(ceilingCandidate({ resolution_tier: "admin", countryCode: "US" }, bundles)).toBeNull()
		expect(ceilingCandidate({ resolution_tier: "admin", countryCode: null }, bundles)).toBeNull()
	})
})

describe("installedBundleNames", () => {
	it("lists the bundles whose artifacts are on disk under the data root", async () => {
		await using scratch = await temporaryDirectory("ceiling-")

		await writeLocalTextFile("", resolvePath(scratch.path, "db", "wof", "candidate.db"))

		expect([...(await installedBundleNames(scratch.path, bundles))]).toEqual(["candidate"])
	})
})
