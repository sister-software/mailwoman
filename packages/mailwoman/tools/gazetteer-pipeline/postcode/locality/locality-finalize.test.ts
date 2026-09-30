/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The finalizer stamps terms already recorded in `meta` into a `postcode_locality` table and its
 *   `layer_manifest`. A second finalize replaces that manifest rather than failing because
 *   the table accumulates across country runs.
 */

import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import { type layerschemadatabase, LayerTier, readLayerManifest } from "@mailwoman/core/layers"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { afterAll, beforeAll, expect, test, vi } from "vitest"

import { finalizePostcodeLocality } from "#gazetteer/postcode/locality/base"
import {
	createPostcodeLocalityTable,
	POSTCODE_LOCALITY_INSERT_SQL,
	type PostcodeLocalityDatabase,
} from "#locality-postcode-schema"

let root: TemporaryDirectory

beforeAll(async () => {
	root = await temporaryDirectory("postcode-locality-")
})

afterAll(() => root[Symbol.asyncDispose]())

test("finalizePostcodeLocality: the manifest states the meta's terms, and a rerun replaces it", async () => {
	const output = root.path("postcode-locality-de.db").toString()

	{
		using db = new DatabaseClient<PostcodeLocalityDatabase>(output)

		await createPostcodeLocalityTable(db, { ifNotExists: true })
		db.prepare(POSTCODE_LOCALITY_INSERT_SQL).run("10115", "DE", 101_748_799, "Berlin", "", 0, 1)
	}

	// The summary line is for an operator's terminal, so the test silences it.
	const log = vi.spyOn(console, "log").mockImplementation(() => {})

	try {
		await finalizePostcodeLocality(output)
		await finalizePostcodeLocality(output)
	} finally {
		log.mockRestore()
	}

	using db = new DatabaseClient<layerschemadatabase>(output, { readOnly: true })

	const meta = db.prepare("SELECT value FROM meta WHERE key = 'license'").get() as { value: string }

	expect(meta.value).toBe("CC-BY 4.0 (Who's On First) — attribution required on redistribution")

	// `readLayerManifest` refuses anything but exactly one row, so it also proves the rerun replaced the first.
	const manifest = await readLayerManifest(db)

	expect(manifest.name).toBe("postcode-locality")
	expect(manifest.tier).toBe(LayerTier.Shipped)
	expect(manifest.license).toBe("CC-BY-4.0")
	expect(manifest.sourceVintage).toBe('{"DE": {"containing": 1, "rows": 1}}')
	expect(manifest.spineKeys).toEqual({ wofID: "locality_id" })
})
