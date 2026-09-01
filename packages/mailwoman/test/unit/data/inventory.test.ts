/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The inventory's classifications, against a fixture data root.
 *
 *   The property under test throughout is that the FOUR states stay distinct. A report that collapsed
 *   "has no manifest" into "could not be opened", or counted a third party's artifact as our debt, would
 *   still print a number — it would just print one nobody can act on, which is the failure mode this
 *   whole phase exists to fix.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { createSymbolicLink, makeDirectories, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import type { LayerContractDatabase } from "@mailwoman/core/layers/schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import {
	buildCommandGaps,
	FOREIGN_ROOTS,
	inventorySentence,
	Provenance,
	probeManifest,
	rebuildHint,
	takeInventory,
} from "mailwoman/data"
import { join } from "path-ts"
import { afterAll, describe, expect, it } from "vitest"

const fixtures = new AsyncDisposableStack()

afterAll(() => fixtures.disposeAsync())

async function dataRoot(): Promise<string> {
	const root = fixtures.use(await temporaryDirectory("mw-inventory-")).path.toString()

	return root
}

/**
 * A database with a `layer_manifest`, in the shipped shape.
 */
async function manifested(path: string, name: string, buildCmd: string): Promise<void> {
	await makeDirectories(join(path, ".."))

	using db = new DatabaseClient<LayerContractDatabase>(path)

	db.exec(`CREATE TABLE layer_manifest (
		name TEXT PRIMARY KEY, version TEXT NOT NULL, schema_version INTEGER NOT NULL, tier TEXT NOT NULL,
		license TEXT NOT NULL, attribution TEXT, source TEXT NOT NULL, source_vintage TEXT NOT NULL,
		build_cmd TEXT NOT NULL, build_sha TEXT NOT NULL, freshness_policy TEXT NOT NULL,
		spine_keys TEXT NOT NULL, created_at TEXT NOT NULL)`)

	db.prepare(
		"INSERT INTO layer_manifest VALUES (?, '1.0', 1, 'shipped', 'ODbL', 'x', 'src', '2026-01-01', ?, 'abc', 'sealed', '{}', '2026-01-01T00:00:00Z')"
	).run(name, buildCmd)
}

/**
 * A built database with no manifest — the ordinary state of most of the data root.
 */
function bare(path: string): void {
	using db = new DatabaseClient<LayerContractDatabase>(path)

	db.exec("CREATE TABLE rows (id INTEGER PRIMARY KEY)")
}

describe("takeInventory — the four states stay distinct", () => {
	it("separates manifested, unprovenanced, foreign and unreadable", async () => {
		const root = await dataRoot()

		await makeDirectories(join(root, "poi"))
		await makeDirectories(join(root, "wof"))
		await makeDirectories(join(root, "pelias-rig", "deep"))

		await manifested(join(root, "poi", "poi.db"), "poi", "mailwoman gazetteer build poi")
		bare(join(root, "wof", "candidate.db"))
		// Not SQLite at all. "We could not look" must not read as "it has no manifest".
		await writeLocalTextFile("this is not a database", join(root, "wof", "broken.db"))

		const report = await takeInventory({ dataRoot: root })

		expect(report.counts[Provenance.Manifested]).toBe(1)
		expect(report.counts[Provenance.Unprovenanced]).toBe(1)
		expect(report.counts[Provenance.Unreadable]).toBe(1)
	})

	it("does not descend into a foreign root, and says how many it skipped", async () => {
		const root = await dataRoot()

		await makeDirectories(join(root, "pelias-rig", "data"))
		await makeDirectories(join(root, "poi"))
		bare(join(root, "pelias-rig", "data", "theirs.db"))
		await manifested(join(root, "poi", "poi.db"), "poi", "mailwoman gazetteer build poi")

		const report = await takeInventory({ dataRoot: root })

		// Counting a third party's build as our debt makes the number unimprovable, so it is skipped rather
		// than classified — and the skip is reported, because a silently bounded walk reads as coverage.
		expect(report.skippedForeign).toBe(1)
		expect(report.entries.some((e) => e.path.startsWith("pelias-rig"))).toBe(false)
		expect(Object.keys(FOREIGN_ROOTS)).toContain("pelias-rig")
	})

	it("reports a symlinked artifact's target, because the link IS the choice", async () => {
		const root = await dataRoot()

		await makeDirectories(join(root, "wof"))
		bare(join(root, "wof", "candidate-2026-08-15.db"))
		await createSymbolicLink(join(root, "wof", "candidate-2026-08-15.db"), join(root, "wof", "candidate.db"))

		const report = await takeInventory({ dataRoot: root })
		const link = report.entries.find((e) => e.path === "wof/candidate.db")

		expect(link?.linkTarget).toBe("wof/candidate-2026-08-15.db")
		// And it still reports the size of what it points at, not the size of the link.
		expect(link?.bytes).toBeGreaterThan(0)
	})

	it("respects maxDepth and reports the depth it used", async () => {
		const root = await dataRoot()

		await makeDirectories(join(root, "a", "b", "c"))
		bare(join(root, "a", "b", "c", "deep.db"))

		expect((await takeInventory({ dataRoot: root, maxDepth: 1 })).entries).toHaveLength(0)
		expect((await takeInventory({ dataRoot: root, maxDepth: 3 })).entries).toHaveLength(1)
		expect((await takeInventory({ dataRoot: root, maxDepth: 1 })).maxDepth).toBe(1)
	})
})

describe("probeManifest", () => {
	it("returns nothing for a database with no manifest, and an error for a non-database", async () => {
		const root = await dataRoot()

		bare(join(root, "plain.db"))
		await writeLocalTextFile("nope", join(root, "junk.db"))

		expect(probeManifest(join(root, "plain.db"))).toEqual({})
		expect(probeManifest(join(root, "junk.db")).error).toBeDefined()
	})

	it("reads the build command, which is what reproduction needs", async () => {
		const root = await dataRoot()

		await manifested(join(root, "poi.db"), "poi", "mailwoman gazetteer build poi")

		expect(probeManifest(join(root, "poi.db")).manifest?.build_cmd).toBe("mailwoman gazetteer build poi")
	})
})

describe("the reported rate", () => {
	it("excludes foreign and unreadable from the denominator, so the number is improvable", async () => {
		const root = await dataRoot()

		await makeDirectories(join(root, "poi"))
		await makeDirectories(join(root, "wof"))
		await manifested(join(root, "poi", "poi.db"), "poi", "cmd")
		bare(join(root, "wof", "a.db"))
		await writeLocalTextFile("nope", join(root, "wof", "junk.db"))

		const sentence = inventorySentence(await takeInventory({ dataRoot: root }))

		// 1 of 2, not 1 of 3: an artifact nobody can open is not a provenance gap someone can close.
		expect(sentence).toContain("1 of 2")
		expect(sentence).toContain("could not be opened")
	})

	it("reports 0 of 0 without dividing by zero", async () => {
		expect(inventorySentence(await takeInventory({ dataRoot: await dataRoot() }))).toContain("0 of 0")
	})
})

describe("rebuildHint", () => {
	it("gives the build command when the artifact carries one", async () => {
		const root = await dataRoot()

		await manifested(join(root, "poi.db"), "poi", "mailwoman gazetteer build poi")

		const entry = (await takeInventory({ dataRoot: root })).entries[0]!

		expect(rebuildHint(entry)).toBe("mailwoman gazetteer build poi")
	})

	it("says unreproducible rather than inventing a command", async () => {
		const root = await dataRoot()

		bare(join(root, "mystery.db"))

		expect(rebuildHint((await takeInventory({ dataRoot: root })).entries[0]!)).toContain("no provenance")
	})
})

describe("buildCommandGaps — a manifest is only worth its build command", () => {
	it("flags a path the workspace regroup moved", async () => {
		// Measured on the shipped osm databases: they record `node osm/out/scripts/build-rooftop-database.js`, which
		// now lives under `packages/osm/`. The literal survived the move INSIDE a built database, where no lint
		// reaches it, and the artifact still passes every "has a manifest" check.
		const root = await dataRoot()

		expect(await buildCommandGaps("node osm/out/scripts/build-rooftop-database.js", root)).toEqual([
			"osm/out/scripts/build-rooftop-database.js",
		])
	})

	it("treats a bare CLI verb as runnable rather than guessing", async () => {
		// Verifying `mailwoman gazetteer build poi` means running the CLI. Reporting it as a gap would flood the
		// report with the artifacts that are actually in the best shape.
		expect(await buildCommandGaps("mailwoman gazetteer build poi", await dataRoot())).toEqual([])
	})

	it("passes a path that does exist", async () => {
		const root = await dataRoot()

		await makeDirectories(join(root, "scripts"))
		await writeLocalTextFile("", join(root, "scripts", "build.ts"))

		expect(await buildCommandGaps("node scripts/build.ts", root)).toEqual([])
	})
})
