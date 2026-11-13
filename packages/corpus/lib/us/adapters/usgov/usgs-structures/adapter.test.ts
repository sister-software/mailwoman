// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Runs the structures adapter over features the USGS structures MapServer served on 2026-11-13.
 *
 *   Two post offices are in Puerto Rico, where ZIP Codes begin with 00,
 *   and one (Pocono Manor) has no street address.
 *   A cemetery's address is a road with no house number, and a campground has a
 *   full address in a layer that doesn't train.
 */

import { workspacePath } from "@mailwoman/core/paths"
import { JSONSpliterator } from "spliterator"
import { describe, expect, it } from "vitest"

import { runAdapter } from "#runner"
import { readCanonicalRows, useScratchDir } from "#test-kit"
import {
	USGOV_USGS_STRUCTURES_ADAPTER_ID,
	USGOV_USGS_STRUCTURES_DEFAULT_LICENSE,
	createUSGovUSGSStructuresAdapter,
	type USGSStructureFeature,
} from "#us/adapters/usgov/usgs-structures/adapter"
import { usgsStructureLayer } from "#us/structures/usgs/layers"
import { alignRow } from "#utils"

const scratch = useScratchDir("usgov-usgs-structures")

const fixture = workspacePath("corpus", "fixtures", "usgov-usgs-structures", "sample.geojsonl")

const sourceID = (permanentIdentifier: string) => `${USGOV_USGS_STRUCTURES_ADAPTER_ID}-${permanentIdentifier}`

async function runFixture() {
	const manifest = await runAdapter({
		adapter: createUSGovUSGSStructuresAdapter(),
		adapterOptions: { inputPath: fixture },
		outputDir: scratch.path,
		corpusVersion: "0.1.0",
	})

	return { manifest, rows: await readCanonicalRows(scratch.path, USGOV_USGS_STRUCTURES_ADAPTER_ID) }
}

async function readSampleFeatures(): Promise<USGSStructureFeature[]> {
	return Array.fromAsync(JSONSpliterator.fromAsync<USGSStructureFeature>(fixture))
}

describe("usgov-usgs-structures adapter", () => {
	it("emits US rows only for features of layers that train", async () => {
		const { manifest, rows } = await runFixture()
		const features = await readSampleFeatures()
		const layerOf = new Map(features.map((feature) => [sourceID(feature.properties.permanent_identifier!), feature]))

		expect(manifest.yielded).toBe(rows.length)
		expect(rows.every((row) => row.country === "US" && row.locale === "en-US")).toBe(true)
		expect(rows.every((row) => row.license === USGOV_USGS_STRUCTURES_DEFAULT_LICENSE)).toBe(true)
		expect(rows.every((row) => usgsStructureLayer(layerOf.get(row.source_id)!.properties.layer_id).trains)).toBe(true)

		// The fixture holds a fully addressed feature of a layer that doesn't train, so the `trains` flag decides its row.
		const addressedButUntrained = features.filter(
			(feature) =>
				!usgsStructureLayer(feature.properties.layer_id).trains &&
				feature.properties.address &&
				feature.properties.city &&
				feature.properties.zipcode
		)

		expect(addressedButUntrained.length).toBeGreaterThan(0)
	})

	it("emits no row for a post office with no street address", async () => {
		const { rows } = await runFixture()

		expect(rows.find((row) => row.source_id === sourceID("c5989229-529a-4596-afd3-c088e64de291"))).toBeUndefined()
	})

	it("renders the name as a venue ahead of the street address, locality, region and postcode", async () => {
		const { rows } = await runFixture()
		const row = rows.find((r) => r.source_id === sourceID("0087eaa9-8730-40a8-9733-23eaffb0afbb"))!

		expect(row.raw).toBe("Palm Bay West Post Office, 950 Malabar Road Southwest, Palm Bay, FL 32907")

		expect(row.components).toMatchObject({
			venue: "Palm Bay West Post Office",
			house_number: "950",
			street: "Malabar Road Southwest",
			locality: "Palm Bay",
			region: "FL",
			postcode: "32907",
		})
	})

	it("labels the locality's words inside the venue as venue, and the locality's own words as locality", async () => {
		const { rows } = await runFixture()
		const row = rows.find((r) => r.source_id === sourceID("0087eaa9-8730-40a8-9733-23eaffb0afbb"))!
		const result = alignRow(row)

		expect(result.kind).toBe("labeled")

		if (result.kind !== "labeled") return

		const palms = result.row.tokens.flatMap((token, index) => (token === "Palm" ? [index] : []))

		expect(palms).toHaveLength(2)
		expect(result.row.labels[palms[0]!]).toBe("B-venue")
		expect(result.row.labels[palms[1]!]).toBe("B-locality")
	})

	it("keeps the leading zeros of a Puerto Rico ZIP Code, and a ZIP+4 whole", async () => {
		const { rows } = await runFixture()
		const caguas = rows.find((r) => r.source_id === sourceID("09da8555-c417-407d-8f43-732d68559157"))!

		expect(caguas.raw).toBe("North Post Office, 555 Calle Munoz Rivera, Caguas, PR 00725")
		expect(caguas.components.postcode).toBe("00725")

		const lakeville = rows.find((r) => r.source_id === sourceID("00689248-e551-41f1-b718-d34eb284db3b"))!

		expect(lakeville.components.postcode).toBe("06039-9992")
	})

	it("labels a cemetery's road as the street when it carries no house number", async () => {
		const { rows } = await runFixture()
		const features = await readSampleFeatures()

		const cemetery = features.find(
			(feature) =>
				feature.properties.layer === "cemeteries" &&
				feature.properties.address &&
				!/^\d/u.test(feature.properties.address) &&
				feature.properties.city &&
				feature.properties.zipcode
		)!

		const row = rows.find((r) => r.source_id === sourceID(cemetery.properties.permanent_identifier!))!

		expect(row.components.house_number).toBeUndefined()
		expect(row.components.street).toBe(cemetery.properties.address)
		expect(row.components.venue).toBe(cemetery.properties.name)
	})

	it("rejects a non-US --country", async () => {
		await expect(
			runAdapter({
				adapter: createUSGovUSGSStructuresAdapter(),
				adapterOptions: { inputPath: fixture, country: "FR" },
				outputDir: scratch.path,
				corpusVersion: "0.1.0",
			})
		).rejects.toThrow(/only US supported/)
	})
})
