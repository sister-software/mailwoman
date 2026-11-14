// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Runs the OPT-NC adapter over six of the 49 agencies the FeatureServer served on
 *   2026-11-14: two street addresses, a village line, a line that repeats the town,
 *   a cadastral lot, and the mail-processing center.
 */

import { workspacePath } from "@mailwoman/core/paths"
import { JSONSpliterator } from "spliterator"
import { describe, expect, it } from "vitest"

import {
	createOPTNCAgencesAdapter,
	NC_OPT_AGENCES_ADAPTER_ID,
	NC_OPT_AGENCES_LICENSE,
	type OPTNCAgencyFeature,
	OPTNCRefusal,
	readOPTNCAgency,
} from "#nc/adapters/opt-nc/adapter"
import { optNCStructureRecord } from "#nc/structures/opt-nc"
import { runAdapter } from "#runner"
import { readCanonicalRows, useScratchDir } from "#test-kit"
import { alignRow } from "#utils"

const scratch = useScratchDir(NC_OPT_AGENCES_ADAPTER_ID)

const fixture = workspacePath("corpus", "fixtures", NC_OPT_AGENCES_ADAPTER_ID, "sample.geojsonl")

async function readSample(): Promise<OPTNCAgencyFeature[]> {
	return Array.fromAsync(JSONSpliterator.fromAsync<OPTNCAgencyFeature>(fixture))
}

async function runFixture() {
	const manifest = await runAdapter({
		adapter: createOPTNCAgencesAdapter(),
		adapterOptions: { inputPath: fixture },
		outputDir: scratch.path,
		corpusVersion: "0.1.0",
	})

	return { manifest, rows: await readCanonicalRows(scratch.path, NC_OPT_AGENCES_ADAPTER_ID) }
}

const byName = (features: readonly OPTNCAgencyFeature[], name: string) =>
	features.find((feature) => feature.properties.nom === name)!

describe("nc-opt-agences adapter", () => {
	it("emits New Caledonia rows that align, one per readable agency", async () => {
		const { manifest, rows } = await runFixture()
		const features = await readSample()

		expect(rows).toHaveLength(features.map(readOPTNCAgency).filter((reading) => "admitted" in reading).length)
		expect(manifest.yielded).toBe(rows.length)
		expect(rows.every((row) => row.country === "NC" && row.license === NC_OPT_AGENCES_LICENSE)).toBe(true)
		expect(rows.every((row) => alignRow(row).kind === "labeled")).toBe(true)
	})

	it("renders the agency's public label as the venue before its street address", async () => {
		const reading = readOPTNCAgency(byName(await readSample(), "KONE"))

		if (!("admitted" in reading)) throw new Error(`refused: ${reading.refused}`)

		expect(reading.admitted.raw).toBe("Agence de KONE, 23 AVENUE DE KONIAMBO, 98859 KONE")

		expect(reading.admitted.components).toMatchObject({
			venue: "Agence de KONE",
			house_number: "23",
			street_prefix: "AVENUE",
		})
	})

	it("reads a village line as the dependent locality and refuses a line that only repeats the town", async () => {
		const features = await readSample()
		const we = readOPTNCAgency(byName(features, "LIFOU WE"))

		if (!("admitted" in we)) throw new Error(`refused: ${we.refused}`)

		expect(we.admitted.components.dependent_locality).toBe("QANONO - VILLAGE DE WE")
		expect(readOPTNCAgency(byName(features, "MARE TADINE"))).toEqual({ refused: OPTNCRefusal.StreetLineAbsent })
		expect(readOPTNCAgency(byName(features, "POUM"))).toEqual({ refused: OPTNCRefusal.StreetLineUnread })
	})

	it("files counters for the structures layer and leaves the mail-processing center out", async () => {
		const features = await readSample()
		const filed = features.map((feature) => optNCStructureRecord(feature, "post-office"))

		expect(filed[features.indexOf(byName(features, "Centre de Traitement Postal"))]).toBeNull()
		expect(filed.filter((record) => record !== null)).toHaveLength(features.length - 1)
		expect(filed[features.indexOf(byName(features, "POUM"))]!.address).toBeNull()
	})
})
