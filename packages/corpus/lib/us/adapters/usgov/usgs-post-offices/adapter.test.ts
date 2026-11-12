// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Runs the post-office adapter over seven features the USGS structures layer served on 2026-11-09.
 *
 *   Two are in Puerto Rico, where ZIP Codes begin with 00.
 *   One (Pocono Manor) has no street address.
 */

import { workspacePath } from "@mailwoman/core/paths"
import { describe, expect, it } from "vitest"

import { runAdapter } from "#runner"
import { readCanonicalRows, useScratchDir } from "#test-kit"
import {
	USGOV_USGS_POST_OFFICES_ADAPTER_ID,
	USGOV_USGS_POST_OFFICES_DEFAULT_LICENSE,
	createUSGovUSGSPostOfficesAdapter,
} from "#us/adapters/usgov/usgs-post-offices/adapter"
import { alignRow } from "#utils"

const scratch = useScratchDir("usgov-usgs-post-offices")

const fixture = workspacePath("corpus", "fixtures", "usgov-usgs-post-offices", "sample.geojsonl")

const sourceID = (permanentIdentifier: string) => `${USGOV_USGS_POST_OFFICES_ADAPTER_ID}-${permanentIdentifier}`

async function runFixture() {
	const manifest = await runAdapter({
		adapter: createUSGovUSGSPostOfficesAdapter(),
		adapterOptions: { inputPath: fixture },
		outputDir: scratch.path,
		corpusVersion: "0.1.0",
	})

	return { manifest, rows: await readCanonicalRows(scratch.path, USGOV_USGS_POST_OFFICES_ADAPTER_ID) }
}

describe("usgov-usgs-post-offices adapter", () => {
	it("emits one US row per post office with a street address, and none for the one without", async () => {
		const { manifest, rows } = await runFixture()

		expect(manifest.yielded).toBe(6)
		expect(rows.every((row) => row.country === "US" && row.locale === "en-US")).toBe(true)
		expect(rows.every((row) => row.license === USGOV_USGS_POST_OFFICES_DEFAULT_LICENSE)).toBe(true)
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

	it("keeps the leading zeros of a Puerto Rico ZIP Code", async () => {
		const { rows } = await runFixture()
		const caguas = rows.find((r) => r.source_id === sourceID("09da8555-c417-407d-8f43-732d68559157"))!

		expect(caguas.raw).toBe("North Post Office, 555 Calle Munoz Rivera, Caguas, PR 00725")

		expect(caguas.components).toMatchObject({
			venue: "North Post Office",
			house_number: "555",
			street: "Calle Munoz Rivera",
			locality: "Caguas",
			region: "PR",
			postcode: "00725",
		})

		const santurce = rows.find((r) => r.source_id === sourceID("0a5fb353-05bb-4ea7-9ff0-2dcc5c66128f"))!

		expect(santurce.components.postcode).toBe("00907")
	})

	it("keeps a ZIP+4 whole", async () => {
		const { rows } = await runFixture()
		const row = rows.find((r) => r.source_id === sourceID("00689248-e551-41f1-b718-d34eb284db3b"))!

		expect(row.components.postcode).toBe("06039-9992")
	})

	it("rejects a non-US --country", async () => {
		await expect(
			runAdapter({
				adapter: createUSGovUSGSPostOfficesAdapter(),
				adapterOptions: { inputPath: fixture, country: "FR" },
				outputDir: scratch.path,
				corpusVersion: "0.1.0",
			})
		).rejects.toThrow(/only US supported/)
	})
})
