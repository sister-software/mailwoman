// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The candidate manifest's provenance chain and four ways the chain can fail.
 *
 *   The lab holds thirteen candidate builds and about ten admin builds.
 *   No record currently pairs them.
 *
 *   The manifest chain records those pairs.
 *   An absent ancestor must remain absent because substituting a filename would look
 *   like provenance without identifying an ancestor build.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import type { PathBuilder } from "path-ts"
import { afterAll, describe, expect, it } from "vitest"

import {
	ancestorIdentity,
	candidateLayerManifest,
	inputsRefusingPublication,
	InputTermsRecord,
	readInputTerms,
} from "#tools/pipeline/manifest/candidate-manifest"

const fixtures = new AsyncDisposableStack()

afterAll(() => fixtures.disposeAsync())

async function scratchDirectory(): Promise<PathBuilder> {
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
function metaLicensed(path: PathBuilder, license: string, tier?: string): void {
	using db = new DatabaseClient<WOFDatabase>(path)

	db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)")
	db.prepare("INSERT INTO meta VALUES ('license', ?)").run(license)

	if (tier) {
		db.prepare("INSERT INTO meta VALUES ('tier', ?)").run(tier)
	}
}

/**
 * A locality database carrying its terms in `database_meta`, as the NZ, CZ and TW builders wrote them.
 */
function databaseMetaLicensed(path: PathBuilder, license: string): void {
	using db = new DatabaseClient<WOFDatabase>(path)

	db.exec("CREATE TABLE database_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID")
	db.prepare("INSERT INTO database_meta VALUES ('license', ?)").run(license)
}

describe("readInputTerms — where a contributing database recorded its terms", () => {
	it("reads a layer manifest's tier and license", async () => {
		const root = await scratchDirectory()

		manifested(root("ni.db"), "postalcode-ni-osm", "2026-08-05", "ODbL-1.0")

		using db = new DatabaseClient<WOFDatabase>(root("ni.db"))
		db.exec("ALTER TABLE layer_manifest ADD COLUMN tier TEXT")
		db.exec("UPDATE layer_manifest SET tier = 'build-local'")

		const terms = await readInputTerms(root("ni.db"))

		expect(terms.recordedIn).toBe(InputTermsRecord.LayerManifest)
		expect(terms.name).toBe("postalcode-ni-osm")
		expect(terms.tier).toBe("build-local")
		expect(terms.license).toBe("ODbL-1.0")
	})

	it("reads a meta table's tier and resolves its prose license", async () => {
		// The state the lab host's `postalcode-ni-osm.db` is in, measured 2026-09-27.
		const root = await scratchDirectory()

		metaLicensed(root("postalcode-ni-osm.db"), "Open Database License (ODbL) 1.0", "build-local")

		const terms = await readInputTerms(root("postalcode-ni-osm.db"))

		expect(terms.recordedIn).toBe(InputTermsRecord.Meta)
		expect(terms.name).toBe("postalcode-ni-osm")
		expect(terms.tier).toBe("build-local")
		expect(terms.license).toBe("ODbL-1.0")
	})

	it("reads database_meta, which the locality builders wrote, and states no tier for it", async () => {
		const root = await scratchDirectory()

		databaseMetaLicensed(root("localities-nz-linz.db"), "CC-BY-4.0, attribution Land Information New Zealand")

		const terms = await readInputTerms(root("localities-nz-linz.db"))

		expect(terms.recordedIn).toBe(InputTermsRecord.DatabaseMeta)
		expect(terms.tier).toBeNull()
		expect(terms.license).toBe("CC-BY-4.0")
	})

	it("reports a database that records no terms, and says why an unreadable one could not be read", async () => {
		const root = await scratchDirectory()

		using silent = new DatabaseClient<WOFDatabase>(root("silent.db"))
		silent.exec("CREATE TABLE spr (id INTEGER PRIMARY KEY)")

		await writeLocalTextFile("not a database", root("broken.db"))

		const none = await readInputTerms(root("silent.db"))
		const broken = await readInputTerms(root("broken.db"))
		const absent = await readInputTerms(root("absent.db"))

		expect(none).toMatchObject({ recordedIn: InputTermsRecord.None, tier: null, license: null })
		expect(none.error).toBeNull()
		expect(broken.recordedIn).toBe(InputTermsRecord.None)
		expect(broken.error).not.toBeNull()
		expect(absent.error).toBe("not found")
	})
})

describe("inputsRefusingPublication", () => {
	it("keeps every database whose stated tier is not shipped, and none that states no tier", () => {
		const base = { path: "/x", name: "x", recordedIn: InputTermsRecord.Meta, license: null }

		const refusing = inputsRefusingPublication([
			{ ...base, tier: "build-local", error: null },
			{ ...base, tier: "private", error: null },
			{ ...base, tier: "shipped", error: null },
			{ ...base, tier: null, error: null },
		])

		expect(refusing.map((input) => input.tier)).toEqual(["build-local", "private"])
	})
})

const BASE = {
	contributingDatabases: { postcodes: [], localities: [] },
	importance: { path: "/db/admin-importance-0123456789ab.db", md5: "0123456789abcdef0123456789abcdef" },
	buildSHA: "abc1234",
	version: "2026-08-17",
	createdAt: "2026-08-17T00:00:00.000Z",
}

describe("ancestorIdentity — the four states", () => {
	it("names the ancestor when it carries a manifest", async () => {
		const root = await scratchDirectory()

		manifested(root("admin.db"), "admin-global-priority", "2026-08-17.0")

		await expect(ancestorIdentity(root("admin.db"))).resolves.toBe("admin-global-priority@2026-08-17.0")
	})

	it("says the ancestor PREDATES the interface, which is the live state today", async () => {
		// Every admin build before phase 3 has no manifest.
		// This is measured rather than hypothetical.
		const root = await scratchDirectory()
		using db = new DatabaseClient<WOFDatabase>(root("admin.db"))

		db.exec("CREATE TABLE spr (id INTEGER PRIMARY KEY)")

		await expect(ancestorIdentity(root("admin.db"))).resolves.toContain("predates the layer interface")
	})

	it("distinguishes a MISSING ancestor from an unmanifested one", async () => {
		// Different repairs: one needs a rebuild of the ancestor, the other needs the ancestor.
		await expect(ancestorIdentity((await scratchDirectory())("nope.db"))).resolves.toContain("not found")
	})

	it("reports an unreadable ancestor rather than throwing mid-build", async () => {
		const root = await scratchDirectory()

		await writeLocalTextFile("not a database", root("admin.db"))

		await expect(ancestorIdentity(root("admin.db"))).resolves.toMatch(/^unknown \(/)
	})

	it("never returns a bare filename, which would look like provenance", async () => {
		for (const answer of [
			await ancestorIdentity((await scratchDirectory())("admin-global-priority.db")),
			await ancestorIdentity("/nope/admin-global-priority.db"),
		]) {
			expect(answer.startsWith("unknown")).toBe(true)
		}
	})
})

describe("candidateLayerManifest", () => {
	it("records the ancestor as its source, not the ancestor's sources", async () => {
		// The ancestor's sources are "whosonfirst+overture+geonames". and unfalsifiable of this file.
		// It couldn't say which admin build this came from.
		const root = await scratchDirectory()

		manifested(root("admin.db"), "admin-global-priority", "2026-08-17.0")

		const manifest = await candidateLayerManifest({ ...BASE, adminDBPath: root("admin.db") })

		expect(manifest.source).toBe("admin-global-priority@2026-08-17.0")
		expect(manifest.source).not.toContain("whosonfirst+")
	})

	it("records the database counts, which nothing else in the artifact says", async () => {
		const root = await scratchDirectory()
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
	})

	it("names the importance build it read, by path and md5", async () => {
		const manifest = await candidateLayerManifest({ ...BASE, adminDBPath: (await scratchDirectory())("n.db") })

		expect(manifest.sourceVintage).toContain(
			"importance=/db/admin-importance-0123456789ab.db importance-md5=0123456789abcdef0123456789abcdef"
		)
	})

	it("distinguishes a build with no importance database, which ranks differently", async () => {
		const manifest = await candidateLayerManifest({
			...BASE,
			importance: null,
			adminDBPath: (await scratchDirectory())("n.db"),
		})

		expect(manifest.sourceVintage).toContain("importance=none")
	})

	it("composes its license from every contributing database's own terms rather than the ancestor's alone", async () => {
		// The defect this replaces: a literal `ODbL-1.0 AND CDLA-Permissive-2.0 AND CC-BY-4.0` stood here
		// while the postcode databases supplied 23.90% of the table's places under terms it didn't name.
		const root = await scratchDirectory()

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
		expect(manifest.sourceVintage).toContain("undeclared-inputs=0")
	})

	it("marks a contributing database that declares no terms, rather than omitting it from the expression", async () => {
		// Measured 2026-09-27: 28 of the 28 postcode and locality databases on the lab host
		// have no `layer_manifest`, and 26 of them have no `meta.license` either.
		// An expression that left them out would read as a complete list of the artifact's terms.
		const root = await scratchDirectory()

		manifested(root("admin.db"), "admin-global-priority", "2026-09-15", "CC-BY-4.0")

		using silent = new DatabaseClient<WOFDatabase>(root("silent.db"))
		silent.exec("CREATE TABLE spr (id INTEGER PRIMARY KEY)")

		const manifest = await candidateLayerManifest({
			...BASE,
			adminDBPath: root("admin.db"),
			contributingDatabases: { postcodes: [root("silent.db")], localities: [] },
		})

		expect(manifest.license).toBe("CC-BY-4.0 AND LicenseRef-Undeclared-Input")
		expect(manifest.sourceVintage).toContain("undeclared-inputs=1")
	})

	it("counts an absent admin database as an undeclared input", async () => {
		const manifest = await candidateLayerManifest({ ...BASE, adminDBPath: (await scratchDirectory())("n.db") })

		expect(manifest.license).toBe("LicenseRef-Undeclared-Input")
		expect(manifest.sourceVintage).toContain("undeclared-inputs=1")
	})

	it("records each source's rows and places under one named field", async () => {
		const adminDBPath = (await scratchDirectory())("n.db")

		const counted = await candidateLayerManifest({
			...BASE,
			adminDBPath,
			rowsBySource: [
				{ source: "wof", rows: 10, places: 4 },
				{ source: "ni-osm", rows: 6, places: 3 },
			],
		})

		expect(counted.sourceVintage).toMatch(/ rows-by-source=wof:10\/4,ni-osm:6\/3$/)

		await expect(candidateLayerManifest({ ...BASE, adminDBPath })).resolves.toMatchObject({
			sourceVintage: expect.stringContaining("rows-by-source=unmeasured"),
		})
	})

	it("records how many contributing databases were build-local, so a publish decision needs no re-read of the inputs", async () => {
		const root = await scratchDirectory()

		manifested(root("admin.db"), "admin-global-priority", "2026-09-15", "CC-BY-4.0")
		metaLicensed(root("postalcode-ni-osm.db"), "Open Database License (ODbL) 1.0", "build-local")
		metaLicensed(root("codepoint.db"), "Open Government Licence v3.0")

		const manifest = await candidateLayerManifest({
			...BASE,
			adminDBPath: root("admin.db"),
			contributingDatabases: { postcodes: [root("postalcode-ni-osm.db"), root("codepoint.db")], localities: [] },
		})

		expect(manifest.sourceVintage).toContain("build-local-inputs=1")
		expect(manifest.license).toBe("CC-BY-4.0 AND ODbL-1.0 AND OGL-UK-3.0")
	})
})
