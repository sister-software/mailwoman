/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `/status` over the real freshness reader (#997) — the seam between the artifacts on disk and the wire.
 *
 *   The reader's own states are covered next door, in `mailwoman`'s `freshness.test.ts`. What is under test
 *   here is the one thing only this side can get wrong: `data_updated` must be OMITTED when no artifact
 *   carried a build date, and the artifacts must still be listed when it is. A response that filled the
 *   field with a boot time would look exactly like a dated deployment to every client that reads it, which
 *   is the trust question the endpoint exists to answer.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { createNominatimApp, type NominatimStatus, nominatimStatus } from "@mailwoman/nominatim"
import { join } from "@mailwoman/platform/path"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { readFreshness } from "mailwoman/freshness"
import { stampLayerManifest } from "mailwoman/gazetteer-pipeline/stamp-manifest"
import { afterAll, expect, test } from "vitest"

const fixtures = new AsyncDisposableStack()

afterAll(() => fixtures.disposeAsync())

/**
 * The one-column table this fixture writes, so the freshness probe reads a file with a declared schema.
 */
interface FreshnessFixtureDatabase {
	rows: { id: number }
}

async function scratch(): Promise<string> {
	const root = fixtures.use(await temporaryDirectory("mw-nominatim-status-")).path

	return root
}

/**
 * A stamped artifact, written through the same `stampLayerManifest` every builder calls.
 */
async function stamped(path: string, createdAt: string): Promise<string> {
	await stampLayerManifest(path, {
		name: "candidate",
		version: "2026-08-17",
		schemaVersion: 1,
		tier: "build-local",
		license: "ODbL-1.0",
		source: "admin-global-priority@2026-08-17",
		sourceVintage: "postcode-shards=24",
		buildCmd: "mailwoman gazetteer build candidate",
		buildSHA: "abc1234",
		freshnessPolicy: "sealed",
		spineKeys: { wofID: "spr_id" },
		createdAt,
	})

	return path
}

/**
 * A built database with no manifest — every gazetteer built before the layer contract.
 */
function bare(path: string): string {
	using db = new DatabaseClient<FreshnessFixtureDatabase>(path)

	db.exec("CREATE TABLE rows (id INTEGER PRIMARY KEY)")

	return path
}

async function statusBody(paths: Array<{ name: string; path: string }>): Promise<NominatimStatus> {
	const status = nominatimStatus(readFreshness(paths))
	const app = createNominatimApp({ status: async () => status })
	const res = await app.request("/status")

	expect(res.status).toBe(200)

	return (await res.json()) as NominatimStatus
}

test("/status carries data_updated + the mailwoman block when the artifact carries a manifest", async () => {
	const path = await stamped(join(await scratch(), "candidate.db"), "2026-08-17T19:21:17.000Z")
	const body = await statusBody([{ name: "gazetteer", path }])

	expect(body.status).toBe(0)
	expect(body.message).toBe("OK")
	expect(body.data_updated).toBe("2026-08-17T19:21:17.000Z")

	const [artifact] = body.mailwoman?.artifacts ?? []

	expect(artifact?.name).toBe("gazetteer")
	expect(artifact?.manifest).toBe("present")
	expect(artifact?.version).toBe("candidate@2026-08-17")
	expect(artifact?.built).toBe("2026-08-17T19:21:17.000Z")
})

test("/status omits data_updated when nothing is stamped, and still names the artifact", async () => {
	const root = scratch()

	const body = await statusBody([
		{ name: "gazetteer", path: bare(join(await root, "candidate.db")) },
		{ name: "reverse-admin", path: join(await root, "never-built.db") },
	])

	// Absent, never fabricated: a client reading this one cannot tell a guessed epoch from a measured one.
	expect(body.data_updated).toBeUndefined()
	expect("data_updated" in body).toBe(false)

	// The artifacts are still listed — an omitted entry cannot be told apart from one nobody opened.
	expect(body.mailwoman?.artifacts.map((artifact) => artifact.manifest)).toEqual(["absent", "absent"])
	expect(body.mailwoman?.artifacts.map((artifact) => artifact.name)).toEqual(["gazetteer", "reverse-admin"])
})

test("/status dates itself from the newest artifact and still reports the unstamped one", async () => {
	const root = scratch()
	const older = await stamped(join(await root, "admin.db"), "2026-08-10T00:00:00.000Z")
	const newer = await stamped(join(await root, "candidate.db"), "2026-08-17T19:21:17.000Z")

	const body = await statusBody([
		{ name: "gazetteer", path: newer },
		{ name: "reverse-admin", path: older },
		{ name: "poi", path: bare(join(await root, "poi.db")) },
	])

	expect(body.data_updated).toBe("2026-08-17T19:21:17.000Z")
	expect(body.mailwoman?.artifacts).toHaveLength(3)
	expect(body.mailwoman?.artifacts.at(-1)?.manifest).toBe("absent")
})
