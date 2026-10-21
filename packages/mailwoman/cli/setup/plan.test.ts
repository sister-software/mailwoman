/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { SETUP_SAMPLE_ADDRESS, setupSummary, tiersFor } from "#cli/setup/plan"
import type { DataBundle } from "#data/bundles"

const candidate: DataBundle = {
	name: "candidate",
	description: "Global admin candidate gazetteer",
	artifacts: [
		{
			remotePath: "gazetteer/x/candidate.db",
			localPath: "wof/candidate.db",
			md5Sidecar: false,
			approxBytes: 2_880_921_600,
		},
	],
	rights: { publishers: [], expression: "CC0-1.0", terms: [], conditions: [], unresolved: [] },
}

const gbStreets: DataBundle = {
	...candidate,
	name: "gb-streets",
	description: "GB street-level atlas tier",
	artifacts: [
		{
			remotePath: "tiers/gb/gb-streets.db",
			localPath: "tiers/gb-streets.db",
			md5Sidecar: false,
			approxBytes: 1_000_000,
		},
	],
	access: "licensed",
	tier: "tier:gb-streets",
	countries: ["GB"],
}

const fr: DataBundle = {
	...candidate,
	name: "fr",
	description: "France address points",
	artifacts: [{ remotePath: "fr/x/fr.db", localPath: "fr/fr.db", md5Sidecar: false, approxBytes: 500 }],
	countries: ["FR"],
}

const bundles = { candidate, "gb-streets": gbStreets, fr }

describe("tiersFor", () => {
	it("lists the global bundles and the bundles for the asked countries, with access and installation", () => {
		expect(tiersFor(["GB"], new Set(["candidate"]), bundles)).toEqual([
			{
				name: "candidate",
				description: "Global admin candidate gazetteer",
				tier: null,
				bytes: 2_880_921_600,
				access: "free",
				installed: true,
			},
			{
				name: "gb-streets",
				description: "GB street-level atlas tier",
				tier: "tier:gb-streets",
				bytes: 1_000_000,
				access: "licensed",
				installed: false,
			},
		])
	})

	it("reads country codes case-insensitively and lists every bundle when no country is asked", () => {
		expect(tiersFor(["fr"], new Set(), bundles).map((row) => row.name)).toEqual(["candidate", "fr"])
		expect(tiersFor([], new Set(), bundles).map((row) => row.name)).toEqual(["candidate", "gb-streets", "fr"])
	})
})

describe("setupSummary", () => {
	const tiers = tiersFor(["GB"], new Set(["candidate"]), bundles)

	it("prints the roots, the parsed components, one line per tier, and the routes to a token", () => {
		const lines = setupSummary(
			{
				dataRoot: "/data",
				configRoot: "/config",
				parse: { status: "ok", components: { house_number: "1600", street: "Pennsylvania Avenue NW" } },
			},
			tiers
		)

		expect(lines).toContain(`Parsed: ${SETUP_SAMPLE_ADDRESS}`)
		expect(lines).toContain("  house_number: 1600")
		expect(lines).toContain("  street: Pennsylvania Avenue NW")

		const candidateLine = lines.find((line) => line.startsWith("  candidate"))
		const gbLine = lines.find((line) => line.startsWith("  gb-streets"))

		expect(candidateLine).toContain("free")
		expect(candidateLine).toContain("installed")
		expect(gbLine).toContain("licensed")
		expect(gbLine).toContain("not installed")
		expect(lines.join("\n")).toContain("mailwoman license declare")
		expect(lines.join("\n")).toContain("mailwoman data pull gb-streets")
	})

	it("states a failed parse with its reason", () => {
		const lines = setupSummary(
			{ dataRoot: "/data", configRoot: "/config", parse: { status: "failed", reason: "no weights" } },
			tiers
		)

		expect(lines).toContain("Parsed: failed (no weights)")
	})
})
