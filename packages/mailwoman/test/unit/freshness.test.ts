/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The freshness reader, against fixtures written by the REAL manifest writer.
 *
 *   The property under test throughout is that an artifact which cannot state its provenance says so. Every
 *   failure this reader can meet — not on disk, no manifest, not a database, an undatable stamp — has to
 *   arrive as its own entry, because on the wire a dropped entry and a guessed epoch are both
 *   indistinguishable from a measured answer, and whether a measured answer exists is the question.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { LayerFreshnessPolicy, LayerTier } from "@mailwoman/core/layers"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { ManifestState, readFreshness } from "mailwoman/freshness"
import { stampLayerManifest } from "mailwoman/gazetteer-pipeline/stamp-manifest"
import { join } from "path-ts"
import { afterAll, describe, expect, it } from "vitest"

const fixtures = new AsyncDisposableStack()

afterAll(() => fixtures.disposeAsync())

async function scratch(): Promise<string> {
	const root = fixtures.use(await temporaryDirectory("mw-freshness-")).path.toString()

	return root
}

/**
 * A stamped artifact, written through `stampLayerManifest` — the same writer every builder uses.
 *
 * The fixture is deliberately not hand-rolled SQL: a reader tested against a table this test invented would keep
 * passing after the contract's own writer changed shape, which is the one regression it exists to catch.
 */
async function stamped(path: string, name: string, createdAt: string): Promise<string> {
	await stampLayerManifest(path, {
		name,
		version: "2026-08-17",
		schemaVersion: 1,
		tier: LayerTier.BuildLocal,
		license: "ODbL-1.0",
		source: "admin-global-priority@2026-08-17",
		sourceVintage: "postcode-databases=24",
		buildCmd: "mailwoman gazetteer build candidate",
		buildSHA: "abc1234",
		freshnessPolicy: LayerFreshnessPolicy.Sealed,
		spineKeys: { wofID: "spr_id" },
		createdAt,
	})

	return path
}

/**
 * A built database with no manifest — the state of every artifact built before the layer contract.
 */
function bare(path: string): string {
	using db = new DatabaseClient<WOFDatabase>(path)

	db.exec("CREATE TABLE rows (id INTEGER PRIMARY KEY)")

	return path
}

describe("readFreshness — a stamped artifact", () => {
	it("reports the build date, the identity, and what it was built from", async () => {
		const path = await stamped(join(await scratch(), "candidate.db"), "candidate", "2026-08-17T19:21:17.000Z")

		const [entry] = (await readFreshness([{ name: "gazetteer", path }])).artifacts

		expect(entry?.manifest).toBe(ManifestState.Present)
		expect(entry?.built).toBe("2026-08-17T19:21:17.000Z")
		expect(entry?.version).toBe("candidate@2026-08-17")
		// The candidate's source is a CHAIN — it names its ancestor admin build — and the vintage carries the
		// database counts that make one candidate build different from another. Both, or neither identifies it.
		expect(entry?.sources).toEqual(["admin-global-priority@2026-08-17", "postcode-databases=24"])
		expect(entry?.reason).toBeUndefined()
	})

	it("dates the whole report from the newest artifact it read", async () => {
		const root = scratch()
		const older = await stamped(join(await root, "admin.db"), "admin-global-priority", "2026-08-10T00:00:00.000Z")
		const newer = await stamped(join(await root, "candidate.db"), "candidate", "2026-08-17T19:21:17.000Z")

		const report = await readFreshness([
			{ name: "gazetteer", path: newer },
			{ name: "reverse-admin", path: older },
		])

		// Verbatim, not re-serialized: the date the artifact states is the date the wire carries.
		expect(report.dataUpdated).toBe("2026-08-17T19:21:17.000Z")
		expect(report.artifacts).toHaveLength(2)
	})
})

describe("readFreshness — an artifact that cannot state its provenance", () => {
	it("reports an unstamped artifact's own absence rather than omitting it", async () => {
		const path = bare(join(await scratch(), "candidate.db"))

		const report = await readFreshness([{ name: "gazetteer", path }])
		const [entry] = report.artifacts

		expect(entry?.manifest).toBe(ManifestState.Absent)
		expect(entry?.name).toBe("gazetteer")
		expect(entry?.path).toBe(path)
		expect(entry?.reason).toContain("predates the layer contract")
		// No date is invented from the file's mtime, and the report declines to date itself.
		expect(entry?.built).toBeUndefined()
		expect(report.dataUpdated).toBeUndefined()
	})

	it("reports a missing file as absence, not as a throw", async () => {
		const path = join(await scratch(), "never-built.db")

		const [entry] = (await readFreshness([{ name: "gazetteer", path }])).artifacts

		expect(entry?.manifest).toBe(ManifestState.Absent)
		expect(entry?.reason).toBe("artifact is not on disk")
	})

	it("keeps 'could not open it' apart from 'it has no manifest'", async () => {
		const path = join(await scratch(), "truncated.db")

		await writeLocalTextFile("this is not a database", path)

		const [entry] = (await readFreshness([{ name: "gazetteer", path }])).artifacts

		// A fault to chase, not a rebuild to schedule. Collapsing the two would file a corrupt artifact under
		// the same heading as one that is merely old.
		expect(entry?.manifest).toBe(ManifestState.Unreadable)
		expect(entry?.reason).toBeDefined()
	})

	it("refuses a stamp it cannot date instead of dropping it from the maximum", async () => {
		const path = await stamped(join(await scratch(), "candidate.db"), "candidate", "whenever")

		const report = await readFreshness([{ name: "gazetteer", path }])
		const [entry] = report.artifacts

		expect(entry?.manifest).toBe(ManifestState.Unreadable)
		expect(entry?.reason).toContain("created_at")
		// Silently skipping it would leave the entry reading like an artifact nobody ever stamped.
		expect(report.dataUpdated).toBeUndefined()
	})

	it("dates a report from the artifacts that could be read, and still lists the ones that could not", async () => {
		const root = scratch()
		const good = await stamped(join(await root, "candidate.db"), "candidate", "2026-08-17T19:21:17.000Z")
		const missing = bare(join(await root, "admin.db"))

		const report = await readFreshness([
			{ name: "gazetteer", path: good },
			{ name: "reverse-admin", path: missing },
		])

		expect(report.dataUpdated).toBe("2026-08-17T19:21:17.000Z")

		expect(report.artifacts.map((artifact) => artifact.manifest)).toEqual([ManifestState.Present, ManifestState.Absent])
	})
})
