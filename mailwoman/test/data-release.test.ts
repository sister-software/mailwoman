/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Versioned data switchover (#485 piece 4): manifest read + path resolution, and the
 *   ShardProvider's zero-downtime atomic reload (version flip + one-generation grace on old
 *   handles). Uses a fake lookup factory + on-disk touch files — no WOF / weights needed.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, test } from "vitest"

import { readReleaseManifest, resolveShardPath } from "../data-release.js"
import { ShardProvider } from "../geocode-core.js"

const dirs: string[] = []
function tmp(): string {
	const d = mkdtempSync(join(tmpdir(), "mw-data-release-"))
	dirs.push(d)
	return d
}
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })))

/** Fake lookups: record the path they were opened from + whether they've been closed. */
class FakeAddressPoints {
	closed = false
	constructor(public dbPath: string) {}
	find() {
		return null
	}
	close() {
		this.closed = true
	}
}
class FakeInterp {
	closed = false
	constructor(public opts: { dbPath: string }) {}
	find() {
		return null
	}
	close() {
		this.closed = true
	}
}
const factory = { AddressPointSqliteLookup: FakeAddressPoints, StreetInterpolator: FakeInterp } as never

/** Ensure a directory exists and return it. */
function dirEnsure(d: string): string {
	mkdirSync(d, { recursive: true })
	return d
}

describe("readReleaseManifest", () => {
	test("reads a valid manifest; null for absent or malformed", () => {
		const root = tmp()
		expect(readReleaseManifest(root)).toBeNull()
		writeFileSync(
			join(root, "releases.json"),
			JSON.stringify({ "address-points": "2026-05-20.0", interpolation: "TIGER2023" })
		)
		expect(readReleaseManifest(root)).toEqual({ "address-points": "2026-05-20.0", interpolation: "TIGER2023" })
		writeFileSync(join(root, "releases.json"), "{ not json")
		expect(readReleaseManifest(root)).toBeNull()
	})
})

describe("resolveShardPath", () => {
	test("prefers the versioned name; falls back to legacy; null if neither", () => {
		const root = tmp()
		const apDir = dirEnsure(join(root, "address-points"))
		// legacy only
		writeFileSync(join(apDir, "address-points-us-tx.db"), "")
		expect(resolveShardPath(root, "address-points", "tx", null)).toBe(join(apDir, "address-points-us-tx.db"))
		// versioned present + pinned → wins
		writeFileSync(join(apDir, "address-points-us-tx-v2.db"), "")
		expect(resolveShardPath(root, "address-points", "tx", { "address-points": "v2" })).toBe(
			join(apDir, "address-points-us-tx-v2.db")
		)
		// pinned version with no file → legacy fallback
		expect(resolveShardPath(root, "address-points", "tx", { "address-points": "v9" })).toBe(
			join(apDir, "address-points-us-tx.db")
		)
		// nothing for an unknown slug
		expect(resolveShardPath(root, "address-points", "zz", null)).toBeNull()
	})
})

describe("ShardProvider atomic switchover", () => {
	test("reload() flips to the new version + retires the old handle with one-gen grace", () => {
		const root = tmp()
		const apDir = dirEnsure(join(root, "address-points"))
		writeFileSync(join(apDir, "address-points-us-tx-v1.db"), "")
		writeFileSync(join(root, "releases.json"), JSON.stringify({ "address-points": "v1" }))

		const provider = new ShardProvider(factory, root)
		const v1 = provider.for("tx").addressPoints as unknown as FakeAddressPoints
		expect(v1.dbPath).toContain("address-points-us-tx-v1.db")
		expect(provider.versions()).toEqual({ "address-points": "v1" })

		// Publish v2 alongside, flip the manifest, reload.
		writeFileSync(join(apDir, "address-points-us-tx-v2.db"), "")
		writeFileSync(join(root, "releases.json"), JSON.stringify({ "address-points": "v2" }))
		expect(provider.reload()).toEqual({ "address-points": "v2" })

		const v2 = provider.for("tx").addressPoints as unknown as FakeAddressPoints
		expect(v2.dbPath).toContain("address-points-us-tx-v2.db")
		// One-generation grace: the v1 handle is retired but NOT yet closed.
		expect(v1.closed).toBe(false)

		// A second reload (no version change) closes the retired v1 handle.
		provider.reload()
		expect(v1.closed).toBe(true)

		provider.close()
		expect(v2.closed).toBe(true)
	})

	test("unchanged version keeps the same open handle (no churn)", () => {
		const root = tmp()
		const apDir = dirEnsure(join(root, "address-points"))
		writeFileSync(join(apDir, "address-points-us-tx-v1.db"), "")
		writeFileSync(join(root, "releases.json"), JSON.stringify({ "address-points": "v1" }))
		const provider = new ShardProvider(factory, root)
		const first = provider.for("tx").addressPoints
		provider.reload()
		expect(provider.for("tx").addressPoints).toBe(first) // same instance — not reopened
		provider.close()
	})
})
