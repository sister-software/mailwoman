// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Versioned data switchover: path resolution, and the region provider reading
 *   the release a manifest pins at construction.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { makeDirectories, writeLocalJSONFile, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { addressPointDatabaseRoot } from "@mailwoman/resolver-wof-sqlite/paths"
import type { PathBuilder } from "path-ts"
import { afterAll, describe, expect, test } from "vitest"

import { resolveDatabasePath } from "#data"
import { createRegionDatabaseProvider } from "#geocode"

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

describe("the region provider's release pinning", () => {
	test("a provider built after the manifest moves reads the new release, and disposal closes its handles", async () => {
		const root = tmp()
		const apDir = await dirEnsure(addressPointDatabaseRoot(await root))
		await writeLocalTextFile("", apDir("address-points-us-tx-v1.db"))
		await writeLocalJSONFile({ "address-points": "v1" }, (await root)("releases.json"))

		const first = await createRegionDatabaseProvider(factory, await root)
		const v1 = first.for("US-TX").addressPoints as FakeAddressPoints
		expect(v1.dbPath).toContain("address-points-us-tx-v1.db")
		expect(first.regions()).toEqual(["US-TX"])

		await writeLocalTextFile("", apDir("address-points-us-tx-v2.db"))
		await writeLocalJSONFile({ "address-points": "v2" }, (await root)("releases.json"))

		// The provider already built keeps reading the release it pinned.
		expect((first.for("US-TX").addressPoints as FakeAddressPoints).dbPath).toContain("address-points-us-tx-v1.db")

		const second = await createRegionDatabaseProvider(factory, await root)
		const v2 = second.for("US-TX").addressPoints as FakeAddressPoints
		expect(v2.dbPath).toContain("address-points-us-tx-v2.db")

		first[Symbol.dispose]()
		expect(v1.closed).toBe(true)
		expect(v2.closed).toBe(false)

		second[Symbol.dispose]()
		expect(v2.closed).toBe(true)
	})
})
