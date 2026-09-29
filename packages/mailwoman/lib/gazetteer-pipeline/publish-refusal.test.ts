/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `publishGazetteer` reads the candidate's own `layer_manifest` before staging a byte. A `build-local`
 *   tier refuses and an absent manifest refuses. Each refusal explains what would lift it.
 */

import { pathExists } from "@mailwoman/core/fs/readers"
import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import { LayerTier } from "@mailwoman/core/layers"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { afterAll, beforeAll, expect, test } from "vitest"

import { publishGazetteer } from "#gazetteer-pipeline"
import { foldLayerManifest, stampLayerManifest } from "#gazetteer/stamp-manifest"

let root: TemporaryDirectory

beforeAll(async () => {
	root = await temporaryDirectory("publish-refusal-")
})

afterAll(() => root[Symbol.asyncDispose]())

test("a build-local candidate is refused by name before staging", async () => {
	const candidateDB = root.path("candidate.db")

	{
		using db = new DatabaseClient<WOFDatabase>(candidateDB)

		db.exec("CREATE TABLE spr (id INTEGER PRIMARY KEY)")
	}

	// The manifest in the lab host's candidate.db, measured 2026-09-27.
	await stampLayerManifest(
		candidateDB,
		foldLayerManifest({
			name: "candidate",
			version: "2026-09-15",
			tier: LayerTier.BuildLocal,
			license: "ODbL-1.0 AND CDLA-Permissive-2.0 AND CC-BY-4.0",
			source: "admin-global-priority@2026-09-15",
			sourceVintage: "fixture",
			buildCmd: "mailwoman gazetteer build candidate",
			buildSHA: "fixture",
			createdAt: "2026-09-15T00:00:00.000Z",
			spineKeys: { wofID: "spr_id" },
		})
	)

	const stageDir = root.path("stage")

	await expect(publishGazetteer({ candidateDB, version: "2026-09-27a", stageDir, dryRun: true })).rejects.toThrow(
		/tier is build-local, and only shipped permits publication/
	)

	await expect(publishGazetteer({ candidateDB, version: "2026-09-27a", stageDir, dryRun: true })).rejects.toThrow(
		/Pass --override-refusals/
	)

	// Refused before the staging link existed.
	expect(await pathExists(stageDir("gazetteer", "2026-09-27a", "candidate.db"))).toBe(false)
})

test("a candidate with no layer_manifest is refused, because it states no tier", async () => {
	const candidateDB = root.path("unmanifested.db")

	{
		using db = new DatabaseClient<WOFDatabase>(candidateDB)

		db.exec("CREATE TABLE spr (id INTEGER PRIMARY KEY)")
	}

	await expect(
		publishGazetteer({ candidateDB, version: "2026-09-27a", stageDir: root.path("stage2"), dryRun: true })
	).rejects.toThrow(/carries no layer_manifest, so it states no tier/)
})
