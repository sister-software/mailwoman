/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Versioned data switchover (#485 piece 4): manifest read + path resolution, and the
 *   RegionDatabaseProvider's zero-downtime atomic reload (version flip + one-generation grace on old
 *   handles). Uses a fake lookup factory + on-disk touch files — no WOF / weights needed.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { makeDirectories, writeLocalJSONFile, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { readReleaseManifest, resolveDatabasePath } from "mailwoman/data"
import { RegionDatabaseProvider } from "mailwoman/geocode"
import { join } from "path-ts"
import { afterAll, describe, expect, test } from "vitest"

const fixtures = new AsyncDisposableStack()

afterAll(() => fixtures.disposeAsync())

async function tmp(): Promise<string> {
	const d = fixtures.use(await temporaryDirectory("mw-data-release-")).path.toString()

	return d
}

/**
 * Fake lookups: record the path they were opened from + whether they've been closed.
 */
class FakeAddressPoints {
	closed = false
	dbPath: string

	constructor(dbPath: string) {
		this.dbPath = dbPath
	}
	find() {
		return null
	}
	[Symbol.dispose]() {
		this.closed = true
	}
}

class FakeInterp {
	closed = false
	opts: { dbPath: string }

	constructor(opts: { dbPath: string }) {
		this.opts = opts
	}
	find() {
		return null
	}
	[Symbol.dispose]() {
		this.closed = true
	}
}

const factory = { AddressPointSqliteLookup: FakeAddressPoints, StreetInterpolator: FakeInterp }

/**
 * Ensure a directory exists and return it.
 */
async function dirEnsure(d: string): Promise<string> {
	await makeDirectories(d)

	return d
}

describe("readReleaseManifest", () => {
	test("reads a valid manifest; null for absent or malformed", async () => {
		const root = tmp()
		expect(await readReleaseManifest(await root)).toBeNull()

		await writeLocalJSONFile(
			{ "address-points": "2026-05-20.0", interpolation: "TIGER2023" },
			join(await root, "releases.json")
		)

		expect(await readReleaseManifest(await root)).toEqual({
			"address-points": "2026-05-20.0",
			interpolation: "TIGER2023",
		})

		await writeLocalTextFile("{ not json", join(await root, "releases.json"))
		expect(await readReleaseManifest(await root)).toBeNull()
	})
})

describe("resolveDatabasePath", () => {
	test("prefers the versioned name; falls back to legacy; null if neither", async () => {
		const root = tmp()
		const apDir = await dirEnsure(join(await root, "address-points"))
		// legacy only
		await writeLocalTextFile("", join(apDir, "address-points-us-tx.db"))

		expect(await resolveDatabasePath(await root, "address-points", "tx", null)).toBe(
			join(apDir, "address-points-us-tx.db")
		)

		// versioned present + pinned → wins
		await writeLocalTextFile("", join(apDir, "address-points-us-tx-v2.db"))

		expect(await resolveDatabasePath(await root, "address-points", "tx", { "address-points": "v2" })).toBe(
			join(apDir, "address-points-us-tx-v2.db")
		)

		// pinned version with no file → legacy fallback
		expect(await resolveDatabasePath(await root, "address-points", "tx", { "address-points": "v9" })).toBe(
			join(apDir, "address-points-us-tx.db")
		)

		// nothing for an unknown slug
		expect(await resolveDatabasePath(await root, "address-points", "zz", null)).toBeNull()
	})
})

describe("RegionDatabaseProvider atomic switchover", () => {
	test("reload() flips to the new version + retires the old handle with one-gen grace", async () => {
		const root = tmp()
		const apDir = await dirEnsure(join(await root, "address-points"))
		await writeLocalTextFile("", join(apDir, "address-points-us-tx-v1.db"))
		await writeLocalJSONFile({ "address-points": "v1" }, join(await root, "releases.json"))

		const provider = await RegionDatabaseProvider.create(factory, await root)
		const v1 = provider.for("tx").addressPoints as FakeAddressPoints
		expect(v1.dbPath).toContain("address-points-us-tx-v1.db")
		expect(provider.versions()).toEqual({ "address-points": "v1" })

		// Publish v2 alongside, flip the manifest, reload.
		await writeLocalTextFile("", join(apDir, "address-points-us-tx-v2.db"))
		await writeLocalJSONFile({ "address-points": "v2" }, join(await root, "releases.json"))
		expect(await provider.reload()).toEqual({ "address-points": "v2" })

		const v2 = provider.for("tx").addressPoints as FakeAddressPoints
		expect(v2.dbPath).toContain("address-points-us-tx-v2.db")
		// One-generation grace: the v1 handle is retired but NOT yet closed.
		expect(v1.closed).toBe(false)

		// A second reload (no version change) closes the retired v1 handle.
		await provider.reload()
		expect(v1.closed).toBe(true)

		provider[Symbol.dispose]()
		expect(v2.closed).toBe(true)
	})

	test("unchanged version keeps the same open handle (no churn)", async () => {
		const root = tmp()
		const apDir = await dirEnsure(join(await root, "address-points"))

		await writeLocalTextFile("", join(apDir, "address-points-us-tx-v1.db"))
		await writeLocalJSONFile({ "address-points": "v1" }, join(await root, "releases.json"))

		await using provider = await RegionDatabaseProvider.create(factory, await root)

		const first = provider.for("tx").addressPoints
		await provider.reload()
		expect(provider.for("tx").addressPoints).toBe(first)
	})
})
