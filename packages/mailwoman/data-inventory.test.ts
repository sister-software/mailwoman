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

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { afterEach, describe, expect, it } from "vitest"

import {
	buildCommandGaps,
	FOREIGN_ROOTS,
	inventorySentence,
	Provenance,
	probeManifest,
	rebuildHint,
	takeInventory,
} from "./data-inventory.ts"

const roots: string[] = []

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true })
	}
})

function dataRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "mw-inventory-"))

	roots.push(root)

	return root
}

/**
 * A database with a `layer_manifest`, in the shipped shape.
 */
function manifested(path: string, name: string, buildCmd: string): void {
	mkdirSync(join(path, ".."), { recursive: true })

	const db = new DatabaseSync(path)

	db.exec(`CREATE TABLE layer_manifest (
		name TEXT PRIMARY KEY, version TEXT NOT NULL, schema_version INTEGER NOT NULL, tier TEXT NOT NULL,
		license TEXT NOT NULL, attribution TEXT, source TEXT NOT NULL, source_vintage TEXT NOT NULL,
		build_cmd TEXT NOT NULL, build_sha TEXT NOT NULL, freshness_policy TEXT NOT NULL,
		spine_keys TEXT NOT NULL, created_at TEXT NOT NULL)`)

	db.prepare(
		"INSERT INTO layer_manifest VALUES (?, '1.0', 1, 'shipped', 'ODbL', 'x', 'src', '2026-01-01', ?, 'abc', 'sealed', '{}', '2026-01-01T00:00:00Z')"
	).run(name, buildCmd)

	db.close()
}

/**
 * A built database with no manifest — the ordinary state of most of the data root.
 */
function bare(path: string): void {
	const db = new DatabaseSync(path)

	db.exec("CREATE TABLE rows (id INTEGER PRIMARY KEY)")
	db.close()
}

describe("takeInventory — the four states stay distinct", () => {
	it("separates manifested, unprovenanced, foreign and unreadable", () => {
		const root = dataRoot()

		mkdirSync(join(root, "poi"), { recursive: true })
		mkdirSync(join(root, "wof"), { recursive: true })
		mkdirSync(join(root, "pelias-rig", "deep"), { recursive: true })

		manifested(join(root, "poi", "poi.db"), "poi", "mailwoman gazetteer build poi")
		bare(join(root, "wof", "candidate.db"))
		// Not SQLite at all. "We could not look" must not read as "it has no manifest".
		writeFileSync(join(root, "wof", "broken.db"), "this is not a database")

		const report = takeInventory({ dataRoot: root })

		expect(report.counts[Provenance.Manifested]).toBe(1)
		expect(report.counts[Provenance.Unprovenanced]).toBe(1)
		expect(report.counts[Provenance.Unreadable]).toBe(1)
	})

	it("does not descend into a foreign root, and says how many it skipped", () => {
		const root = dataRoot()

		mkdirSync(join(root, "pelias-rig", "data"), { recursive: true })
		mkdirSync(join(root, "poi"), { recursive: true })
		bare(join(root, "pelias-rig", "data", "theirs.db"))
		manifested(join(root, "poi", "poi.db"), "poi", "mailwoman gazetteer build poi")

		const report = takeInventory({ dataRoot: root })

		// Counting a third party's build as our debt makes the number unimprovable, so it is skipped rather
		// than classified — and the skip is reported, because a silently bounded walk reads as coverage.
		expect(report.skippedForeign).toBe(1)
		expect(report.entries.some((e) => e.path.startsWith("pelias-rig"))).toBe(false)
		expect(Object.keys(FOREIGN_ROOTS)).toContain("pelias-rig")
	})

	it("reports a symlinked artifact's target, because the link IS the choice", () => {
		const root = dataRoot()

		mkdirSync(join(root, "wof"), { recursive: true })
		bare(join(root, "wof", "candidate-2026-08-15.db"))
		symlinkSync(join(root, "wof", "candidate-2026-08-15.db"), join(root, "wof", "candidate.db"))

		const report = takeInventory({ dataRoot: root })
		const link = report.entries.find((e) => e.path === "wof/candidate.db")

		expect(link?.linkTarget).toBe("wof/candidate-2026-08-15.db")
		// And it still reports the size of what it points at, not the size of the link.
		expect(link?.bytes).toBeGreaterThan(0)
	})

	it("respects maxDepth and reports the depth it used", () => {
		const root = dataRoot()

		mkdirSync(join(root, "a", "b", "c"), { recursive: true })
		bare(join(root, "a", "b", "c", "deep.db"))

		expect(takeInventory({ dataRoot: root, maxDepth: 1 }).entries).toHaveLength(0)
		expect(takeInventory({ dataRoot: root, maxDepth: 3 }).entries).toHaveLength(1)
		expect(takeInventory({ dataRoot: root, maxDepth: 1 }).maxDepth).toBe(1)
	})
})

describe("probeManifest", () => {
	it("returns nothing for a database with no manifest, and an error for a non-database", () => {
		const root = dataRoot()

		bare(join(root, "plain.db"))
		writeFileSync(join(root, "junk.db"), "nope")

		expect(probeManifest(join(root, "plain.db"))).toEqual({})
		expect(probeManifest(join(root, "junk.db")).error).toBeDefined()
	})

	it("reads the build command, which is what reproduction needs", () => {
		const root = dataRoot()

		manifested(join(root, "poi.db"), "poi", "mailwoman gazetteer build poi")

		expect(probeManifest(join(root, "poi.db")).manifest?.build_cmd).toBe("mailwoman gazetteer build poi")
	})
})

describe("the reported rate", () => {
	it("excludes foreign and unreadable from the denominator, so the number is improvable", () => {
		const root = dataRoot()

		mkdirSync(join(root, "poi"), { recursive: true })
		mkdirSync(join(root, "wof"), { recursive: true })
		manifested(join(root, "poi", "poi.db"), "poi", "cmd")
		bare(join(root, "wof", "a.db"))
		writeFileSync(join(root, "wof", "junk.db"), "nope")

		const sentence = inventorySentence(takeInventory({ dataRoot: root }))

		// 1 of 2, not 1 of 3: an artifact nobody can open is not a provenance gap someone can close.
		expect(sentence).toContain("1 of 2")
		expect(sentence).toContain("could not be opened")
	})

	it("reports 0 of 0 without dividing by zero", () => {
		expect(inventorySentence(takeInventory({ dataRoot: dataRoot() }))).toContain("0 of 0")
	})
})

describe("rebuildHint", () => {
	it("gives the build command when the artifact carries one", () => {
		const root = dataRoot()

		manifested(join(root, "poi.db"), "poi", "mailwoman gazetteer build poi")

		const entry = takeInventory({ dataRoot: root }).entries[0]!

		expect(rebuildHint(entry)).toBe("mailwoman gazetteer build poi")
	})

	it("says unreproducible rather than inventing a command", () => {
		const root = dataRoot()

		bare(join(root, "mystery.db"))

		expect(rebuildHint(takeInventory({ dataRoot: root }).entries[0]!)).toContain("no provenance")
	})
})

describe("buildCommandGaps — a manifest is only worth its build command", () => {
	it("flags a path the workspace regroup moved", () => {
		// Measured on the shipped osm shards: they record `node osm/out/scripts/build-rooftop-shard.js`, which
		// now lives under `packages/osm/`. The literal survived the move INSIDE a built database, where no lint
		// reaches it, and the artifact still passes every "has a manifest" check.
		const root = dataRoot()

		expect(buildCommandGaps("node osm/out/scripts/build-rooftop-shard.js", root)).toEqual([
			"osm/out/scripts/build-rooftop-shard.js",
		])
	})

	it("treats a bare CLI verb as runnable rather than guessing", () => {
		// Verifying `mailwoman gazetteer build poi` means running the CLI. Reporting it as a gap would flood the
		// report with the artifacts that are actually in the best shape.
		expect(buildCommandGaps("mailwoman gazetteer build poi", dataRoot())).toEqual([])
	})

	it("passes a path that does exist", () => {
		const root = dataRoot()

		mkdirSync(join(root, "scripts"), { recursive: true })
		writeFileSync(join(root, "scripts", "build.ts"), "")

		expect(buildCommandGaps("node scripts/build.ts", root)).toEqual([])
	})
})
