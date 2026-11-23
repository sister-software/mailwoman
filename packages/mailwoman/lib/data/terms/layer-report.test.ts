// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The layer report over a fixture data root: a read manifest, a database without the table,
 *   a table the core reader refuses, and a file that isn't a database each keep their
 *   own state, and none of the unread ones reports a license.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { makeDirectories, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { type LayerManifest, writeLayerManifest } from "@mailwoman/core/layers/manifest"
import { createLayerManifestTable, type layerschemadatabase } from "@mailwoman/core/layers/schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import type { PathBuilder } from "path-ts"
import { afterAll, describe, expect, it } from "vitest"

import { takeInventory } from "#data/catalog/inventory"
import { buildLayerReport, layerFamily, layerReportSummaryLines } from "#data/terms/layer-report"

const fixtures = new AsyncDisposableStack()

afterAll(() => fixtures.disposeAsync())

const US_LAYER: LayerManifest = {
	name: "addresses-us-wi",
	version: "2026-11-13",
	schemaVersion: 1,
	tier: "shipped",
	license: "CC-BY-4.0",
	attribution: null,
	source: "usgov-nad+openaddresses",
	sourceVintage: "2026-11-13",
	buildCmd: "mailwoman situs layer",
	buildSHA: "deadbeef",
	freshnessPolicy: "versioned-refresh",
	spineKeys: { h3: { column: "h3_cell", resolution: 6 } },
	createdAt: "2026-11-11T17:15:42Z",
	sourceRecords: null,
}

async function withManifest(path: PathBuilder, manifest: LayerManifest): Promise<void> {
	await makeDirectories(path.dirname())

	using db = new DatabaseClient<layerschemadatabase>(path)

	await createLayerManifestTable(db)
	await writeLayerManifest(db, manifest)
}

async function bare(path: PathBuilder): Promise<void> {
	await makeDirectories(path.dirname())

	using db = new DatabaseClient<layerschemadatabase>(path)

	db.exec("CREATE TABLE rows (id INTEGER PRIMARY KEY)")
}

/**
 * A manifest row whose license the core reader refuses, written past the validating writer.
 */
async function inadmissible(path: PathBuilder): Promise<void> {
	await makeDirectories(path.dirname())

	using db = new DatabaseClient<layerschemadatabase>(path)

	await createLayerManifestTable(db)

	db.prepare(
		"INSERT INTO layer_manifest (name, version, schema_version, tier, license, attribution, source, source_vintage, build_cmd, build_sha, freshness_policy, spine_keys, created_at) VALUES ('soil', '1', 1, 'shipped', 'PDDL-1.0-USGov-NRCS', NULL, 'nrcs', '2026', 'cmd', 'abc', 'sealed', '{\"wofID\":\"wof_id\"}', '2026-01-01T00:00:00Z')"
	).run()
}

describe("buildLayerReport", () => {
	it("keeps read, absent, invalid and unopenable apart, and locates the sources it knows", async () => {
		const root = fixtures.use(await temporaryDirectory("mw-layer-report-")).path

		// A versioned address layer sits four directories below the data root.
		await withManifest(root("db", "addresses", "us-wi", "2026-11-13", "lookup.db"), US_LAYER)
		await bare(root("db", "interpolation", "interpolation-us-wi.db"))
		await inadmissible(root("db", "soil", "soil.db"))
		await makeDirectories(root("db", "wof"))
		await writeLocalTextFile("this is not a database", root("db", "wof", "broken.db"))

		const inventory = await takeInventory({ dataRoot: root })

		const report = buildLayerReport(inventory, {
			locate: (name) => (name === "usgov-nad" ? { title: "NAD", url: "https://nad.example" } : null),
			unavailable: [],
		})

		const state = Object.fromEntries(report.entries.map((entry) => [entry.path, entry.manifest]))

		expect(state).toEqual({
			"db/addresses/us-wi/2026-11-13/lookup.db": "read",
			"db/interpolation/interpolation-us-wi.db": "absent",
			"db/soil/soil.db": "invalid",
			"db/wof/broken.db": "unopenable",
		})

		expect(report.entries.filter((entry) => entry.manifest !== "read").every((entry) => !entry.terms)).toBe(true)

		expect(report.entries.find((entry) => entry.manifest === "absent")?.reason).toBe(
			"the database has no layer_manifest table"
		)

		expect(report.sources.map(({ name, url }) => [name, url])).toEqual([
			["openaddresses", null],
			["usgov-nad", "https://nad.example"],
		])

		expect(report.licenses).toEqual([
			{
				identifier: "CC-BY-4.0",
				obligations: ["attribution"],
				recognized: true,
				textURL: "https://spdx.org/licenses/CC-BY-4.0.html",
				databases: 1,
			},
		])

		expect(report.families.find((family) => family.family === "db/addresses")).toEqual({
			family: "db/addresses",
			read: 1,
			unread: 0,
		})

		const summary = layerReportSummaryLines(report)

		// Every state is counted in one line, so the states sum to the databases listed.
		expect(summary[0]).toBe("layer manifests: 1 read + 1 invalid + 1 absent + 1 unopenable = 4 databases")

		// An invalid or unopenable database is listed by its path, and an absent one only by its family's count.
		expect(summary).toContain("      db/soil/soil.db")
		expect(summary).toContain("      db/wof/broken.db")
		expect(summary.join("\n")).not.toContain("db/interpolation/interpolation-us-wi.db")

		expect(summary.find((line) => line.trimStart().startsWith("db/interpolation"))).toMatch(
			/^ {2}db\/interpolation\s+1 {2}absent: the database has no layer_manifest table$/
		)
	})
})

describe("layerFamily", () => {
	it("names a database group layer by its directory, and any other database by its first directory", () => {
		expect(layerFamily("db/addresses/us-wi/2026-11-13/lookup.db")).toBe("db/addresses")
		expect(layerFamily("audits/3061/admin.db")).toBe("audits")
		expect(layerFamily("loose.db")).toBe(".")
	})
})
