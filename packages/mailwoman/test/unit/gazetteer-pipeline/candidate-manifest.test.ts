/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The candidate manifest's provenance CHAIN, and the four ways it can fail to have one.
 *
 *   The lab holds thirteen candidate builds and about ten admin builds, and which pairs with which is
 *   recorded nowhere. That is the gap the chain closes, and it is only closed if an absent ancestor reads
 *   as absent — substituting the file's name would look like provenance and carry none.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { join } from "@mailwoman/platform/path"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { ancestorIdentity, candidateLayerManifest } from "mailwoman/gazetteer-pipeline/candidate-manifest"
import { afterAll, describe, expect, it } from "vitest"

const fixtures = new AsyncDisposableStack()

afterAll(() => fixtures.disposeAsync())

async function scratch(): Promise<string> {
	const root = fixtures.use(await temporaryDirectory("mw-candidate-manifest-")).path

	return root
}

/**
 * An admin database with a manifest naming `name@version`.
 */
function manifested(path: string, name: string, version: string): void {
	using db = new DatabaseClient<WOFDatabase>(path)

	db.exec("CREATE TABLE layer_manifest (name TEXT PRIMARY KEY, version TEXT NOT NULL)")
	db.prepare("INSERT INTO layer_manifest VALUES (?, ?)").run(name, version)
}

const BASE = {
	shardCounts: { postcodes: 24, localities: 3 },
	importance: true,
	buildSHA: "abc1234",
	version: "2026-08-17",
	createdAt: "2026-08-17T00:00:00.000Z",
}

describe("ancestorIdentity — the four states", () => {
	it("names the ancestor when it carries a manifest", async () => {
		const root = await scratch()

		manifested(join(root, "admin.db"), "admin-global-priority", "2026-08-17.0")

		expect(await ancestorIdentity(join(root, "admin.db"))).toBe("admin-global-priority@2026-08-17.0")
	})

	it("says the ancestor PREDATES the contract, which is the live state today", async () => {
		// Every admin build before phase 3 has no manifest. This is measured, not hypothetical.
		const root = await scratch()
		using db = new DatabaseClient<WOFDatabase>(join(root, "admin.db"))

		db.exec("CREATE TABLE spr (id INTEGER PRIMARY KEY)")

		expect(await ancestorIdentity(join(root, "admin.db"))).toContain("predates the layer contract")
	})

	it("distinguishes a MISSING ancestor from an unmanifested one", async () => {
		// Different repairs: one needs a rebuild of the ancestor, the other needs the ancestor.
		expect(await ancestorIdentity(join(await scratch(), "nope.db"))).toContain("not found")
	})

	it("reports an unreadable ancestor rather than throwing mid-build", async () => {
		const root = await scratch()

		await writeLocalTextFile("not a database", join(root, "admin.db"))

		expect(await ancestorIdentity(join(root, "admin.db"))).toMatch(/^unknown \(/)
	})

	it("never returns a bare filename, which would look like provenance", async () => {
		for (const answer of [
			await ancestorIdentity(join(await scratch(), "admin-global-priority.db")),
			await ancestorIdentity("/nope/admin-global-priority.db"),
		]) {
			expect(answer.startsWith("unknown")).toBe(true)
		}
	})
})

describe("candidateLayerManifest", () => {
	it("records the ancestor as its source, not the ancestor's sources", async () => {
		// Restating "whosonfirst+overture+geonames" here would be true of the ancestor and unfalsifiable of
		// this file — it could not say WHICH admin build this came from.
		const root = await scratch()

		manifested(join(root, "admin.db"), "admin-global-priority", "2026-08-17.0")

		const manifest = await candidateLayerManifest({ ...BASE, adminDBPath: join(root, "admin.db") })

		expect(manifest.source).toBe("admin-global-priority@2026-08-17.0")
		expect(manifest.source).not.toContain("whosonfirst+")
	})

	it("records the shard counts, which nothing else in the artifact says", async () => {
		const manifest = await candidateLayerManifest({ ...BASE, adminDBPath: join(await scratch(), "nope.db") })

		expect(manifest.sourceVintage).toContain("postcode-shards=24")
		expect(manifest.sourceVintage).toContain("locality-shards=3")
		expect(manifest.sourceVintage).toContain("importance=yes")
	})

	it("distinguishes a build with no importance database, which ranks differently", async () => {
		const manifest = await candidateLayerManifest({
			...BASE,
			importance: false,
			adminDBPath: join(await scratch(), "n.db"),
		})

		expect(manifest.sourceVintage).toContain("importance=no")
	})

	it("carries the ancestor's obligations — ODbL is share-alike, so never `shipped`", async () => {
		const manifest = await candidateLayerManifest({ ...BASE, adminDBPath: join(await scratch(), "n.db") })

		expect(manifest.tier).toBe("build-local")
		expect(manifest.license).toContain("ODbL-1.0")
	})

	it("declares the spine that joins back to the ancestor", async () => {
		// `spr_id` only means something against a KNOWN admin build, which is the reason the chain is worth
		// having at all.
		const manifest = await candidateLayerManifest({ ...BASE, adminDBPath: join(await scratch(), "n.db") })

		expect(manifest.spineKeys).toEqual({ wofID: "spr_id" })
	})

	it("names a build command with no path tokens, so a workspace move cannot stale it", async () => {
		const manifest = await candidateLayerManifest({ ...BASE, adminDBPath: join(await scratch(), "n.db") })

		expect(manifest.buildCmd).toBe("mailwoman gazetteer build candidate")
		expect(manifest.buildCmd).not.toContain("/")
	})
})
