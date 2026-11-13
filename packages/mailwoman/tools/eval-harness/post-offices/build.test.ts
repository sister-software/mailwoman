// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Builds the post-office suite from the registered USGS National Map source over the
 *   structures fixture, laid out as `mailwoman corpus fetch usgs-structures` writes it,
 *   and reads the frozen dataset back through the held-out reader.
 *
 *   The fixture holds post offices from the 2026-11-13 pull, one of them (Pocono Manor)
 *   with no street address, beside features of the other layers.
 *   The suite leaves those out.
 */

import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import { copyFileTo, writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { workspacePath } from "@mailwoman/core/paths"
import {
	USGOV_USGS_STRUCTURES_ADAPTER_ID,
	USGS_STRUCTURES_FILENAME,
	type USGSStructureFeature,
} from "@mailwoman/corpus/us/adapters/usgov/usgs-structures/adapter"
import { usgsNationalMapStructures } from "@mailwoman/corpus/us/structures/usgs-national-map"
import { PathBuilder } from "path-ts"
import { JSONSpliterator } from "spliterator"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { readHeldoutDatasetRows } from "#tools/eval-harness/heldout/dataset/manifest"
import { buildPostOfficeSuite } from "#tools/eval-harness/post-offices/build"
import type { PostOfficeSuiteRow } from "#tools/eval-harness/post-offices/rows"

const fixture = workspacePath("corpus", "fixtures", "usgov-usgs-structures", "sample.geojsonl")

let scratch: TemporaryDirectory

beforeEach(async () => {
	scratch = await temporaryDirectory("post-office-suite-")
})

afterEach(() => scratch[Symbol.asyncDispose]())

async function build() {
	const sourcesRoot = PathBuilder.from(scratch.path("sources"))

	await copyFileTo(fixture, sourcesRoot(USGOV_USGS_STRUCTURES_ADAPTER_ID, USGS_STRUCTURES_FILENAME))

	await writeLocalJSONFile(
		{ downloaded_at: "2026-11-13T21:00:00.000Z" },
		sourcesRoot(USGOV_USGS_STRUCTURES_ADAPTER_ID, "MANIFEST.json")
	)

	return buildPostOfficeSuite({
		sources: [usgsNationalMapStructures],
		sourcesRoot,
		outDirectory: scratch.path("suite").toString(),
		createdAt: "2026-11-11T00:00:00Z",
	})
}

describe("buildPostOfficeSuite", () => {
	it("writes an address row and a venue-address row for each post office with an address, and none for other structures", async () => {
		const features = await Array.fromAsync(JSONSpliterator.fromAsync<USGSStructureFeature>(fixture))
		const postOffices = features.filter((feature) => feature.properties.layer === "post-offices")
		const built = await build()

		expect(features.length).toBeGreaterThan(postOffices.length)
		expect(built.sources[0]!.tally).toMatchObject({ records: postOffices.length, "record:no-address": 1 })
		expect(built.rows).toHaveLength((postOffices.length - 1) * 2)
		expect(built.manifest.sampling.method).toBe("every-row")

		const postOfficeIDs = new Set(postOffices.map((feature) => feature.properties.permanent_identifier))

		expect(built.rows.every((row) => postOfficeIDs.has(row.group!))).toBe(true)

		const { rows } = await readHeldoutDatasetRows(built.manifestPath)

		expect(rows).toHaveLength(built.rows.length)

		const caguas = (rows as PostOfficeSuiteRow[]).filter((row) => row.group === "09da8555-c417-407d-8f43-732d68559157")

		expect(caguas.map((row) => [row.form, row.raw])).toEqual([
			["address", "555 Calle Munoz Rivera, Caguas, PR 00725"],
			["venue-address", "North Post Office, 555 Calle Munoz Rivera, Caguas, PR 00725"],
		])

		expect(caguas[1]!.expected).toEqual({
			venue: "North Post Office",
			house_number: "555",
			street: "Calle Munoz Rivera",
			locality: "Caguas",
			region: "PR",
			postcode: "00725",
		})

		expect(caguas.every((row) => row.country === "US" && row.provenance === "mapping-agency")).toBe(true)
	})

	it("aligns each expected component onto the row's text", async () => {
		const { rows } = await build()
		const palmBay = rows.find((row) => row.source_id === "0087eaa9-8730-40a8-9733-23eaffb0afbb#venue-address")!

		const spans = palmBay.span_tags.map((tag, index) => [
			tag,
			palmBay.raw.slice(palmBay.span_starts[index], palmBay.span_ends[index]),
		])

		expect(spans).toEqual([
			["venue", "Palm Bay West Post Office"],
			["house_number", "950"],
			["street", "Malabar Road Southwest"],
			["locality", "Palm Bay"],
			["region", "FL"],
			["postcode", "32907"],
		])
	})
})
