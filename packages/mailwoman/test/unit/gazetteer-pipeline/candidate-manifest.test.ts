/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The candidate manifest's provenance chain, and the four ways it can fail to have one.
 *
 *   The lab holds thirteen candidate builds and about ten admin builds, and which pairs with which is
 *   recorded nowhere. That is the gap the chain closes, and it is only closed if an absent ancestor reads
 *   as absent — substituting the file's name would look like provenance and carry none.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { ancestorIdentity, candidateLayerManifest } from "mailwoman/gazetteer-pipeline/candidate-manifest"
import type { PathBuilder } from "path-ts"
import { afterAll, describe, expect, it } from "vitest"

const fixtures = new AsyncDisposableStack()

afterAll(() => fixtures.disposeAsync())

async function scratch(): Promise<PathBuilder> {
	return fixtures.use(await temporaryDirectory("mw-candidate-manifest-")).path
}

/**
 * An admin database with a manifest naming `name@version`, and optionally a license expression.
 */
function manifested(path: PathBuilder, name: string, version: string, license?: string): void {
	using db = new DatabaseClient<WOFDatabase>(path)

	db.exec("CREATE TABLE layer_manifest (name TEXT PRIMARY KEY, version TEXT NOT NULL, license TEXT)")
	db.prepare("INSERT INTO layer_manifest VALUES (?, ?, ?)").run(name, version, license ?? null)
}

/**
 * A postcode database carrying its terms in a `meta` key/value table, as every one on the lab host does.
 */
function metaLicensed(path: PathBuilder, license: string): void {
	using db = new DatabaseClient<WOFDatabase>(path)

	db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)")
	db.prepare("INSERT INTO meta VALUES ('license', ?)").run(license)
}

const BASE = {
	contributingDatabases: { postcodes: [], localities: [] },
	importance: true,
	buildSHA: "abc1234",
	version: "2026-08-17",
	createdAt: "2026-08-17T00:00:00.000Z",
}

describe("ancestorIdentity — the four states", () => {
	it("names the ancestor when it carries a manifest", async () => {
		const root = await scratch()

		manifested(root("admin.db"), "admin-global-priority", "2026-08-17.0")

		expect(await ancestorIdentity(root("admin.db"))).toBe("admin-global-priority@2026-08-17.0")
	})

	it("says the ancestor PREDATES the interface, which is the live state today", async () => {
		// Every admin build before phase 3 has no manifest.
		// This is measured rather than hypothetical.
		const root = await scratch()
		using db = new DatabaseClient<WOFDatabase>(root("admin.db"))

		db.exec("CREATE TABLE spr (id INTEGER PRIMARY KEY)")

		expect(await ancestorIdentity(root("admin.db"))).toContain("predates the layer interface")
	})

	it("distinguishes a MISSING ancestor from an unmanifested one", async () => {
		// Different repairs: one needs a rebuild of the ancestor, the other needs the ancestor.
		expect(await ancestorIdentity((await scratch())("nope.db"))).toContain("not found")
	})

	it("reports an unreadable ancestor rather than throwing mid-build", async () => {
		const root = await scratch()

		await writeLocalTextFile("not a database", root("admin.db"))

		expect(await ancestorIdentity(root("admin.db"))).toMatch(/^unknown \(/)
	})

	it("never returns a bare filename, which would look like provenance", async () => {
		for (const answer of [
			await ancestorIdentity((await scratch())("admin-global-priority.db")),
			await ancestorIdentity("/nope/admin-global-priority.db"),
		]) {
			expect(answer.startsWith("unknown")).toBe(true)
		}
	})
})

describe("candidateLayerManifest", () => {
	it("records the ancestor as its source, not the ancestor's sources", async () => {
		// Restating "whosonfirst+overture+geonames" here would be true of the ancestor
		// and unfalsifiable of this file.
		// It could not say which admin build this came from.
		const root = await scratch()

		manifested(root("admin.db"), "admin-global-priority", "2026-08-17.0")

		const manifest = await candidateLayerManifest({ ...BASE, adminDBPath: root("admin.db") })

		expect(manifest.source).toBe("admin-global-priority@2026-08-17.0")
		expect(manifest.source).not.toContain("whosonfirst+")
	})

	it("records the database counts, which nothing else in the artifact says", async () => {
		const root = await scratch()
		const postcodes = [root("pc1.db"), root("pc2.db")]

		for (const path of postcodes) {
			metaLicensed(path, "CC0-1.0")
		}

		metaLicensed(root("loc.db"), "CC0-1.0")

		const manifest = await candidateLayerManifest({
			...BASE,
			adminDBPath: root("nope.db"),
			contributingDatabases: { postcodes, localities: [root("loc.db")] },
		})

		expect(manifest.sourceVintage).toContain("postcode-databases=2")
		expect(manifest.sourceVintage).toContain("locality-databases=1")
		expect(manifest.sourceVintage).toContain("importance=yes")
	})

	it("distinguishes a build with no importance database, which ranks differently", async () => {
		const manifest = await candidateLayerManifest({
			...BASE,
			importance: false,
			adminDBPath: (await scratch())("n.db"),
		})

		expect(manifest.sourceVintage).toContain("importance=no")
	})

	it("is never `shipped`, whatever its folds declare", async () => {
		const manifest = await candidateLayerManifest({ ...BASE, adminDBPath: (await scratch())("n.db") })

		expect(manifest.tier).toBe("build-local")
	})

	it("composes its license from every fold's own terms rather than the ancestor's alone", async () => {
		// The defect this replaces: a literal `ODbL-1.0 AND CDLA-Permissive-2.0 AND CC-BY-4.0` stood here
		// while the postcode folds supplied 23.90% of the table's places under terms it did not name.
		const root = await scratch()

		manifested(root("admin.db"), "admin-global-priority", "2026-09-15", "ODbL-1.0 AND CC-BY-4.0")
		metaLicensed(root("codepoint.db"), "Open Government Licence v3.0")
		metaLicensed(root("nz.db"), "CC-BY-4.0")

		const manifest = await candidateLayerManifest({
			...BASE,
			adminDBPath: root("admin.db"),
			contributingDatabases: { postcodes: [root("codepoint.db")], localities: [root("nz.db")] },
		})

		// Sorted and deduplicated, so two builds of one input write the same expression.
		expect(manifest.license).toBe("CC-BY-4.0 AND ODbL-1.0 AND OGL-UK-3.0")
		expect(manifest.sourceVintage).toContain("undeclared-folds=0")
	})

	it("marks a fold that declares no terms, rather than omitting it from the expression", async () => {
		// Measured 2026-09-27: 28 of the 28 postcode and locality databases on the lab host
		// carry no `layer_manifest`, and 26 of them carry no `meta.license` either.
		// An expression that simply left them out would read as a complete list of the artifact's terms.
		const root = await scratch()

		manifested(root("admin.db"), "admin-global-priority", "2026-09-15", "CC-BY-4.0")

		using silent = new DatabaseClient<WOFDatabase>(root("silent.db"))
		silent.exec("CREATE TABLE spr (id INTEGER PRIMARY KEY)")

		const manifest = await candidateLayerManifest({
			...BASE,
			adminDBPath: root("admin.db"),
			contributingDatabases: { postcodes: [root("silent.db")], localities: [] },
		})

		expect(manifest.license).toBe("CC-BY-4.0 AND LicenseRef-Undeclared-Input")
		expect(manifest.sourceVintage).toContain("undeclared-folds=1")
	})

	it("counts an absent admin database as an undeclared fold", async () => {
		const manifest = await candidateLayerManifest({ ...BASE, adminDBPath: (await scratch())("n.db") })

		expect(manifest.license).toBe("LicenseRef-Undeclared-Input")
		expect(manifest.sourceVintage).toContain("undeclared-folds=1")
	})

	it("declares the spine that joins back to the ancestor", async () => {
		// `spr_id` only means something against a known admin build, which is the reason the chain is worth having at all.
		const manifest = await candidateLayerManifest({ ...BASE, adminDBPath: (await scratch())("n.db") })

		expect(manifest.spineKeys).toEqual({ wofID: "spr_id" })
	})

	it("names a build command with no path tokens, so a workspace move cannot stale it", async () => {
		const manifest = await candidateLayerManifest({ ...BASE, adminDBPath: (await scratch())("n.db") })

		expect(manifest.buildCmd).toBe("mailwoman gazetteer build candidate")
		expect(manifest.buildCmd).not.toContain("/")
	})
})
