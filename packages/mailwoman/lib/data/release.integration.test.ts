/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Versioned data switchover: manifest read and path resolution. It also tests the `USStateDatabaseProvider`'s zero-downtime atomic reload with a one-generation grace on old handles.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { makeDirectories, writeLocalJSONFile, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { addressPointDatabaseRoot } from "@mailwoman/resolver-wof-sqlite/paths"
import type { PathBuilder } from "path-ts"
import { afterAll, describe, expect, test } from "vitest"

import { readReleaseManifest, resolveDatabasePath } from "#data"
import { USStateDatabaseProvider } from "#geocode"

const fixtures = new AsyncDisposableStack()

afterAll(() => fixtures.disposeAsync())

async function tmp(): Promise<PathBuilder> {
	return fixtures.use(await temporaryDirectory("mw-data-release-")).path
}

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

async function dirEnsure(d: PathBuilder): Promise<PathBuilder> {
	await makeDirectories(d)

	return d
}

describe("readReleaseManifest", () => {
	test("reads a valid manifest; null for absent or malformed", async () => {
		const root = tmp()
		expect(await readReleaseManifest(await root)).toBeNull()

		await writeLocalJSONFile(
			{ "address-points": "2026-05-20.0", interpolation: "TIGER2023" },
			(await root)("releases.json")
		)

		expect(await readReleaseManifest(await root)).toEqual({
			"address-points": "2026-05-20.0",
			interpolation: "TIGER2023",
		})

		await writeLocalTextFile("{ not json", (await root)("releases.json"))
		expect(await readReleaseManifest(await root)).toBeNull()
	})
})

describe("resolveDatabasePath", () => {
	test("prefers the versioned name; falls back to legacy; null if neither", async () => {
		const root = tmp()
		const apDir = await dirEnsure(addressPointDatabaseRoot(await root))
		await writeLocalTextFile("", apDir("address-points-us-tx.db"))

		expect(await resolveDatabasePath(await root, "address-points", "tx", null)).toBe(
			apDir("address-points-us-tx.db").toString()
		)

		await writeLocalTextFile("", apDir("address-points-us-tx-v2.db"))

		expect(await resolveDatabasePath(await root, "address-points", "tx", { "address-points": "v2" })).toBe(
			apDir("address-points-us-tx-v2.db").toString()
		)

		expect(await resolveDatabasePath(await root, "address-points", "tx", { "address-points": "v9" })).toBe(
			apDir("address-points-us-tx.db").toString()
		)

		expect(await resolveDatabasePath(await root, "address-points", "zz", null)).toBeNull()
	})
})

describe("RegionDatabaseProvider atomic switchover", () => {
	test("reload() flips to the new version + retires the old handle with one-gen grace", async () => {
		const root = tmp()
		const apDir = await dirEnsure(addressPointDatabaseRoot(await root))
		await writeLocalTextFile("", apDir("address-points-us-tx-v1.db"))
		await writeLocalJSONFile({ "address-points": "v1" }, (await root)("releases.json"))

		const provider = await USStateDatabaseProvider.create(factory, await root)
		const v1 = provider.for("tx").addressPoints as FakeAddressPoints
		expect(v1.dbPath).toContain("address-points-us-tx-v1.db")
		expect(provider.versions()).toEqual({ "address-points": "v1" })

		await writeLocalTextFile("", apDir("address-points-us-tx-v2.db"))
		await writeLocalJSONFile({ "address-points": "v2" }, (await root)("releases.json"))
		expect(await provider.reload()).toEqual({ "address-points": "v2" })

		const v2 = provider.for("tx").addressPoints as FakeAddressPoints
		expect(v2.dbPath).toContain("address-points-us-tx-v2.db")
		expect(v1.closed).toBe(false)

		await provider.reload()
		expect(v1.closed).toBe(true)

		provider[Symbol.dispose]()
		expect(v2.closed).toBe(true)
	})

	test("unchanged version keeps the same open handle (no churn)", async () => {
		const root = tmp()
		const apDir = await dirEnsure(addressPointDatabaseRoot(await root))

		await writeLocalTextFile("", apDir("address-points-us-tx-v1.db"))
		await writeLocalJSONFile({ "address-points": "v1" }, (await root)("releases.json"))

		using provider = await USStateDatabaseProvider.create(factory, await root)

		const first = provider.for("tx").addressPoints
		await provider.reload()
		expect(provider.for("tx").addressPoints).toBe(first)
	})
})
