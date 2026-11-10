/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Versioned data switchover: path resolution, and the `USStateDatabaseProvider` reading the release a manifest
 *   pins at construction.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { makeDirectories, writeLocalJSONFile, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { addressPointDatabaseRoot } from "@mailwoman/resolver-wof-sqlite/paths"
import type { PathBuilder } from "path-ts"
import { afterAll, describe, expect, test } from "vitest"

import { resolveDatabasePath } from "#data"
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
	readonly radiusCalibration = null
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

describe("resolveDatabasePath", () => {
	test("prefers the versioned name; falls back to legacy; null if neither", async () => {
		const root = tmp()
		const apDir = await dirEnsure(addressPointDatabaseRoot(await root))
		await writeLocalTextFile("", apDir("address-points-us-tx.db"))

		await expect(resolveDatabasePath(await root, "address-points", "tx", null)).resolves.toBe(
			apDir("address-points-us-tx.db").toString()
		)

		await writeLocalTextFile("", apDir("address-points-us-tx-v2.db"))

		await expect(resolveDatabasePath(await root, "address-points", "tx", { "address-points": "v2" })).resolves.toBe(
			apDir("address-points-us-tx-v2.db").toString()
		)

		await expect(resolveDatabasePath(await root, "address-points", "tx", { "address-points": "v9" })).resolves.toBe(
			apDir("address-points-us-tx.db").toString()
		)

		await expect(resolveDatabasePath(await root, "address-points", "zz", null)).resolves.toBeNull()
	})
})

describe("USStateDatabaseProvider release pinning", () => {
	test("a provider built after the manifest moves reads the new release, and disposal closes its handles", async () => {
		const root = tmp()
		const apDir = await dirEnsure(addressPointDatabaseRoot(await root))
		await writeLocalTextFile("", apDir("address-points-us-tx-v1.db"))
		await writeLocalJSONFile({ "address-points": "v1" }, (await root)("releases.json"))

		const first = await USStateDatabaseProvider.create(factory, await root)
		const v1 = first.for("tx").addressPoints as FakeAddressPoints
		expect(v1.dbPath).toContain("address-points-us-tx-v1.db")
		expect(first.versions()).toEqual({ "address-points": "v1" })

		await writeLocalTextFile("", apDir("address-points-us-tx-v2.db"))
		await writeLocalJSONFile({ "address-points": "v2" }, (await root)("releases.json"))

		// The provider already built keeps reading the release it pinned.
		expect((first.for("tx").addressPoints as FakeAddressPoints).dbPath).toContain("address-points-us-tx-v1.db")

		const second = await USStateDatabaseProvider.create(factory, await root)
		const v2 = second.for("tx").addressPoints as FakeAddressPoints
		expect(v2.dbPath).toContain("address-points-us-tx-v2.db")
		expect(second.versions()).toEqual({ "address-points": "v2" })

		first[Symbol.dispose]()
		expect(v1.closed).toBe(true)
		expect(v2.closed).toBe(false)

		second[Symbol.dispose]()
		expect(v2.closed).toBe(true)
	})
})
