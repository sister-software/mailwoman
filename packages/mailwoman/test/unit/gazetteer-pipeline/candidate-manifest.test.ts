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

import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { ancestorIdentity, candidateLayerManifest } from "mailwoman/gazetteer-pipeline/candidate-manifest"
import { afterEach, describe, expect, it } from "vitest"

const roots: string[] = []

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true })
	}
})

function scratch(): string {
	const root = mkdtempSync(join(tmpdir(), "mw-candidate-manifest-"))

	roots.push(root)

	return root
}

/**
 * An admin database with a manifest naming `name@version`.
 */
function manifested(path: string, name: string, version: string): void {
	const db = new DatabaseSync(path)

	db.exec("CREATE TABLE layer_manifest (name TEXT PRIMARY KEY, version TEXT NOT NULL)")
	db.prepare("INSERT INTO layer_manifest VALUES (?, ?)").run(name, version)
	db.close()
}

const BASE = {
	shardCounts: { postcodes: 24, localities: 3 },
	importance: true,
	buildSHA: "abc1234",
	version: "2026-08-17",
	createdAt: "2026-08-17T00:00:00.000Z",
}

describe("ancestorIdentity — the four states", () => {
	it("names the ancestor when it carries a manifest", () => {
		const root = scratch()

		manifested(join(root, "admin.db"), "admin-global-priority", "2026-08-17.0")

		expect(ancestorIdentity(join(root, "admin.db"))).toBe("admin-global-priority@2026-08-17.0")
	})

	it("says the ancestor PREDATES the contract, which is the live state today", () => {
		// Every admin build before phase 3 has no manifest. This is measured, not hypothetical.
		const root = scratch()
		const db = new DatabaseSync(join(root, "admin.db"))

		db.exec("CREATE TABLE spr (id INTEGER PRIMARY KEY)")
		db.close()

		expect(ancestorIdentity(join(root, "admin.db"))).toContain("predates the layer contract")
	})

	it("distinguishes a MISSING ancestor from an unmanifested one", () => {
		// Different repairs: one needs a rebuild of the ancestor, the other needs the ancestor.
		expect(ancestorIdentity(join(scratch(), "nope.db"))).toContain("not found")
	})

	it("reports an unreadable ancestor rather than throwing mid-build", () => {
		const root = scratch()

		writeFileSync(join(root, "admin.db"), "not a database")

		expect(ancestorIdentity(join(root, "admin.db"))).toMatch(/^unknown \(/)
	})

	it("never returns a bare filename, which would look like provenance", () => {
		for (const answer of [
			ancestorIdentity(join(scratch(), "admin-global-priority.db")),
			ancestorIdentity("/nope/admin-global-priority.db"),
		]) {
			expect(answer.startsWith("unknown")).toBe(true)
		}
	})
})

describe("candidateLayerManifest", () => {
	it("records the ancestor as its source, not the ancestor's sources", () => {
		// Restating "whosonfirst+overture+geonames" here would be true of the ancestor and unfalsifiable of
		// this file — it could not say WHICH admin build this came from.
		const root = scratch()

		manifested(join(root, "admin.db"), "admin-global-priority", "2026-08-17.0")

		const manifest = candidateLayerManifest({ ...BASE, adminDBPath: join(root, "admin.db") })

		expect(manifest.source).toBe("admin-global-priority@2026-08-17.0")
		expect(manifest.source).not.toContain("whosonfirst+")
	})

	it("records the shard counts, which nothing else in the artifact says", () => {
		const manifest = candidateLayerManifest({ ...BASE, adminDBPath: join(scratch(), "nope.db") })

		expect(manifest.sourceVintage).toContain("postcode-shards=24")
		expect(manifest.sourceVintage).toContain("locality-shards=3")
		expect(manifest.sourceVintage).toContain("importance=yes")
	})

	it("distinguishes a build with no importance database, which ranks differently", () => {
		const manifest = candidateLayerManifest({ ...BASE, importance: false, adminDBPath: join(scratch(), "n.db") })

		expect(manifest.sourceVintage).toContain("importance=no")
	})

	it("carries the ancestor's obligations — ODbL is share-alike, so never `shipped`", () => {
		const manifest = candidateLayerManifest({ ...BASE, adminDBPath: join(scratch(), "n.db") })

		expect(manifest.tier).toBe("build-local")
		expect(manifest.license).toContain("ODbL-1.0")
	})

	it("declares the spine that joins back to the ancestor", () => {
		// `spr_id` only means something against a KNOWN admin build, which is the reason the chain is worth
		// having at all.
		const manifest = candidateLayerManifest({ ...BASE, adminDBPath: join(scratch(), "n.db") })

		expect(manifest.spineKeys).toEqual({ wofID: "spr_id" })
	})

	it("names a build command with no path tokens, so a workspace move cannot stale it", () => {
		const manifest = candidateLayerManifest({ ...BASE, adminDBPath: join(scratch(), "n.db") })

		expect(manifest.buildCmd).toBe("mailwoman gazetteer build candidate")
		expect(manifest.buildCmd).not.toContain("/")
	})
})
