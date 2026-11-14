// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Runs the La Poste adapter over ten rows of `laposte-poincont2` as data.laposte.fr
 *   served it on 2026-11-14 (data updated 2026-11-08): a bureau de poste with
 *   and without its type code, a relais poste with a shop name in its complement,
 *   a relais in a merged commune, a Réunion office, a parcel partner, an Andorran office,
 *   a site with no street line, and a street name holding a date.
 */

import { workspacePath } from "@mailwoman/core/paths"
import { JSONSpliterator } from "spliterator"
import { describe, expect, it } from "vitest"

import {
	createLaPostePoincontAdapter,
	FR_LAPOSTE_POINCONT_ADAPTER_ID,
	FR_LAPOSTE_POINCONT_LICENSE,
	LaPosteRefusal,
	type LaPostePoincontRecord,
	readLaPosteRecord,
} from "#fr/adapters/laposte-poincont/adapter"
import { laPosteStructureRecord } from "#fr/structures/laposte"
import { runAdapter } from "#runner"
import { readCanonicalRows, useScratchDir } from "#test-kit"
import { alignRow } from "#utils"

const scratch = useScratchDir(FR_LAPOSTE_POINCONT_ADAPTER_ID)

const fixture = workspacePath("corpus", "fixtures", FR_LAPOSTE_POINCONT_ADAPTER_ID, "sample.jsonl")

const sourceID = (id: string) => `${FR_LAPOSTE_POINCONT_ADAPTER_ID}-${id}`

async function runFixture() {
	const dropped = new Map<string, number>()

	const manifest = await runAdapter({
		adapter: createLaPostePoincontAdapter(),
		adapterOptions: { inputPath: fixture, dropped },
		outputDir: scratch.path,
		corpusVersion: "0.1.0",
	})

	return { manifest, dropped, rows: await readCanonicalRows(scratch.path, FR_LAPOSTE_POINCONT_ADAPTER_ID) }
}

async function readSample(): Promise<LaPostePoincontRecord[]> {
	return Array.fromAsync(JSONSpliterator.fromAsync<LaPostePoincontRecord>(fixture))
}

describe("fr-laposte-poincont adapter", () => {
	it("emits a row per readable site and counts each refusal under its reason", async () => {
		const { manifest, rows } = await runFixture()
		const records = await readSample()
		const readings = records.map(readLaPosteRecord)

		expect(rows).toHaveLength(readings.filter((reading) => "admitted" in reading).length)
		expect(manifest.yielded).toBe(rows.length)
		expect(rows.every((row) => row.license === FR_LAPOSTE_POINCONT_LICENSE)).toBe(true)
		expect(rows.every((row) => alignRow(row).kind === "labeled")).toBe(true)

		const refusals = readings.flatMap((reading) => ("refused" in reading ? [reading.refused] : []))

		expect(refusals.toSorted()).toEqual(
			[LaPosteRefusal.NotFrance, LaPosteRefusal.StreetLineAbsent, LaPosteRefusal.StreetLineUnread].toSorted()
		)
	})

	it("drops the label's type code from the venue and keeps the rest of the label", async () => {
		const { rows } = await runFixture()
		const dombes = rows.find((row) => row.source_id === sourceID("00002A"))!

		expect(dombes.raw).toBe("AMBERIEU EN DOMBES, 240 RUE GOMBETTE, 01330 AMBERIEUX EN DOMBES")

		expect(dombes.components).toMatchObject({
			venue: "AMBERIEU EN DOMBES",
			house_number: "240",
			street_prefix: "RUE",
			street: "GOMBETTE",
			postcode: "01330",
			locality: "AMBERIEUX EN DOMBES",
		})

		const partner = rows.find((row) => row.source_id === sourceID("14104D"))!

		expect(partner.components.venue).toBe("ST CYR SUR MER CARREFOUR CITY")
	})

	it("reads the lieu-dit of a merged commune as its dependent locality and leaves the complement out", async () => {
		const { rows, dropped } = await runFixture()
		const chavannes = rows.find((row) => row.source_id === sourceID("00047A"))!

		expect(chavannes.components.dependent_locality).toBe("CHAVANNES SUR SURAN")
		expect(chavannes.components.locality).toBe("NIVIGNE ET SURAN")
		expect(chavannes.raw).not.toContain("FLORALIES TABAC")
		expect(dropped.get("component:complement:unread")).toBeGreaterThan(0)
	})

	it("stamps an overseas site with its own jurisdiction", async () => {
		const { rows } = await runFixture()
		const reunion = rows.find((row) => row.source_id === sourceID("07952B"))!

		expect(reunion.country).toBe("RE")
		expect(reunion.locale).toBe("fr-RE")
		expect(reunion.components.postcode).toBe("97480")
	})

	it("files post offices for the structures layer and leaves the parcel partner out", async () => {
		const records = await readSample()
		const filed = records.map((record) => laPosteStructureRecord(record, "post-office"))
		const partner = records.findIndex((record) => record.identifiant_a === "14104D")

		expect(filed[partner]).toBeNull()
		expect(filed.filter((record) => record !== null)).toHaveLength(records.length - 1)

		const amberieu = filed.find((record) => record?.id === "00001A")!

		expect(amberieu.point).toEqual({ latitude: 45.9598, longitude: 5.3582 })
		expect(amberieu.address).toMatchObject({ house_number: "38", street: "ALEXANDRE BERARD", postcode: "01500" })
	})
})
