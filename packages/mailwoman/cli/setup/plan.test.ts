/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { changeMode, makeDirectories, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { describe, expect, it } from "vitest"

import {
	Capability,
	installedBundles,
	InstallationReadError,
	nextInstallation,
	readInstallationPlan,
	SETUP_SAMPLE_ADDRESS,
	setupCapabilities,
	setupSummary,
	tiersFor,
} from "#cli/setup/plan"
import { BUNDLES, type DataBundle } from "#data/bundles"
import { planInstallation } from "#data/plan"

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

describe("setupCapabilities and nextInstallation", () => {
	const parse = { status: "ok", components: {} } as const

	it("keeps parsing available on an empty data root and offers the gazetteer first, then one state", async () => {
		await using root = await temporaryDirectory("mw-setup-empty-")
		const plan = await planInstallation({ dataRoot: root.path, bundles: ["candidate", "us"] })

		expect(setupCapabilities(parse, plan).map((row) => [row.capability, row.state])).toEqual([
			[Capability.Parsing, "available"],
			[Capability.PlaceResolution, "unavailable"],
			[Capability.Rooftop, "unavailable"],
			[Capability.Interpolation, "unavailable"],
		])

		const next = nextInstallation(plan)

		expect(next[0]).toMatch(/^mailwoman data pull candidate {3}# 2\.9 GB$/u)

		expect(next[1]).toMatch(
			/^mailwoman data pull us --only <state> {3}# one of 52 states, from .+ \(vi\) to .+ \(ca\)$/u
		)

		expect(installedBundles(plan)).toEqual(new Set())
	})

	it("reads files at the conventional paths as installed and names the one state that is", async () => {
		await using root = await temporaryDirectory("mw-setup-legacy-")

		await writeLocalTextFile("candidate", root.path("db", "wof", "candidate.db"))
		await writeLocalTextFile("dc", root.path("db", "address-points", "address-points-us-dc.db"))

		const plan = await planInstallation({ dataRoot: root.path, bundles: ["candidate", "us"] })
		const rows = setupCapabilities(parse, plan)

		expect(rows.find((row) => row.capability === Capability.PlaceResolution)?.state).toBe("available")

		expect(rows.find((row) => row.capability === Capability.Rooftop)).toEqual({
			capability: Capability.Rooftop,
			state: "partial",
			detail: `installed for 1 of ${BUNDLES["us"]!.artifacts.filter((a) => a.family === "address-points").length} published scopes (US-DC)`,
		})

		expect(nextInstallation(plan)).toHaveLength(1)
		expect(installedBundles(plan)).toEqual(new Set(["candidate"]))
	})
})

describe("readInstallationPlan", () => {
	it("reports the path the failed system call reports", async () => {
		const failure = Object.assign(new Error("EACCES: permission denied, stat '/data/db/wof/candidate.db'"), {
			code: "EACCES",
			path: "/data/db/wof/candidate.db",
		})

		const read = readInstallationPlan("/data", ["candidate"], () => Promise.reject(failure))

		await expect(read).rejects.toThrow(InstallationReadError)

		await expect(read).rejects.toThrow(
			"setup could not read the installation at /data/db/wof/candidate.db: EACCES: permission denied"
		)
	})

	it("reports the data root when the failure reports no path", async () => {
		await expect(
			readInstallationPlan("/data", ["candidate"], () => Promise.reject(new Error("bad manifest")))
		).rejects.toThrow("setup could not read the installation at /data: bad manifest")
	})

	it("reports a malformed release manifest instead of reading the installation as unpinned", async () => {
		await using root = await temporaryDirectory("mw-setup-manifest-")
		const manifest = root.path("releases.json")

		await writeLocalTextFile("{ not json", manifest)

		await expect(readInstallationPlan(root.path, ["candidate"])).rejects.toThrow(
			`setup could not read the installation at ${manifest}: ${manifest} is unreadable (corrupt)`
		)
	})

	it("reports a malformed active selection instead of reading the installation as empty", async () => {
		await using root = await temporaryDirectory("mw-setup-selection-")
		const selection = root.path("active.json")

		await writeLocalTextFile("{ not json", selection)

		await expect(readInstallationPlan(root.path, ["candidate"])).rejects.toThrow(
			`setup could not read the installation at ${selection}: ${selection} is unreadable (corrupt)`
		)
	})

	// A process running as root reads a mode-000 directory, so the case cannot fail there.
	it.skipIf(process.getuid?.() === 0)("reports an unreadable data root instead of an empty installation", async () => {
		await using root = await temporaryDirectory("mw-setup-unreadable-")
		const locked = root.path("db", "wof")

		await makeDirectories(locked)
		await changeMode(locked, 0o000)

		try {
			await expect(readInstallationPlan(root.path, ["candidate"])).rejects.toThrow(
				`setup could not read the installation at ${locked("candidate.db")}`
			)
		} finally {
			await changeMode(locked, 0o755)
		}
	})
})
