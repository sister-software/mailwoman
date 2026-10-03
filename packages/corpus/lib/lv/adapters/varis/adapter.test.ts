/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { describe, expect, it } from "vitest"

import {
	createVarisAdapter,
	LV_VARIS_ADAPTER_ID,
	LV_VARIS_LICENSE,
	readVarisBuilding,
	VARIS_TABLES,
	VarisAddressType,
	type VarisPlace,
	type VarisRecord,
	VarisRefusal,
} from "#lv/adapters/varis/adapter"
import { runAdapter } from "#runner"
import { readCanonicalRows, useScratchDir } from "#test-kit"
import { SurfaceOrigin } from "#types"
import { alignRow } from "#utils/align"

const scratch = useScratchDir("lv-varis")

const BOM = "﻿"

const PLACE_HEADER =
	'"KODS","TIPS_CD","NOSAUKUMS","VKUR_CD","VKUR_TIPS","APSTIPR","APST_PAK","STATUSS","SORT_NOS","DAT_SAK","DAT_MOD","DAT_BEIG","ATRIB","STD"'

/**
 * Records copied from the 2026-09-30 edition: ten active building addresses spanning
 * every address type, one removed and one erroneous, and the parent chain of each.
 */
const TABLES: Record<string, string[]> = {
	[VARIS_TABLES.Building]: [
		'"KODS","TIPS_CD","STATUSS","APSTIPR","APST_PAK","VKUR_CD","VKUR_TIPS","NOSAUKUMS","SORT_NOS","ATRIB","PNOD_CD","DAT_SAK","DAT_MOD","DAT_BEIG","FOR_BUILD","PLAN_ADR","STD","KOORD_X","KOORD_Y","DD_N","DD_E"',
		'"101000034","108","EKS","Y","252","100015122","105","Riņņi","Riņņi","LV-4211","100038994","1999.03.19","2021.06.30","","N","N","""Riņņi"", Vecates pag., Valmieras nov., LV-4211","403626.965","568822.179","57.769418","25.156929"',
		'"101003948","108","EKS","Y","252","100408201","107","18","0018","LV-4219","100039336","1999.03.19","2021.06.30","","N","N","Ozolu iela 18, Valmiermuiža, Valmieras pag., Valmieras nov., LV-4219","379560.175","584560.071","57.550612","25.412977"',
		'"101105106","108","EKS","Y","252","100408804","107","Ozoli","Ozoli","LV-3905","100030666","2000.12.19","2021.06.30","","N","N","Bauskas iela Ozoli, Bārbele, Bārbeles pag., Bauskas nov., LV-3905","256734.763","536922.767","56.453672","24.599057"',
		'"101165372","108","EKS","Y","252","100140040","106","Vilidža ","Vilidža ","LV-5656","100037332","2001.01.17","2022.07.07","","N","N","""Vilidža "", Kombuļi, Kombuļu pag., Krāslavas nov., LV-5656","207745.873","698901.095","55.973753","27.187617"',
		'"101335418","108","EKS","Y","252","100378680","107","4","0004","LV-5316","100034608","2003.04.28","2009.06.30","","N","N","Atpūtas iela 4, Līvāni, Līvānu nov., LV-5316","246466.447","634310.36","56.343812","26.17305"',
		'"101844053","108","EKS","Y","254","100306223","107","1","0001","LV-1050","100036693","2001.01.25","2003.01.10","","N","N","Krišjāņa Barona iela 1, Rīga, LV-1050","311789.914","507150.882","56.949673","24.117556"',
		'"102748756","108","EKS","Y","252","100011228","105","Stacija ""Biksti""","Stacija ""Biksti""","LV-3713","100030842","1999.08.19","2013.06.22","","N","N","""Stacija ""Biksti"""", Bikstu pag., Dobeles nov., LV-3713","283493.832","437588.192","56.691356","22.981008"',
		'"102774708","108","EKS","Y","253","100188041","106","Ilgas","Ilgas","LV-3261","100038414","2001.03.23","2009.06.30","","N","N","""Ilgas"", Tiņģere, Īves pag., Talsu nov., LV-3261","368002.082","411666.541","57.446102","22.528177"',
		'"105156152","108","EKS","Y","252","100003831","104","Ierasti","Ierasti","LV-2123","100033944","2005.11.04","2022.06.30","","Y","N","""Ierasti"", Ķekava, Ķekavas nov., LV-2123","299071.003","512933.932","56.835286","24.211976"',
		'"106849064","108","EKS","Y","252","100328634","107","19 k-1","0019 k-0001","LV-3411","100034384","2020.02.24","2020.02.26","","N","N","Bērzu iela 19 k-1, Liepāja, LV-3411","265924.774","316413.259","56.501866","21.017097"',
		'"101001003","108","DEL","Y","252","100014602","105","Ausekļi","Ausekļi","LV-4213","100037461","1999.03.19","2021.06.30","2011.08.17","Y","Y","""Ausekļi"", Sēļu pag., Valmieras nov., LV-4213","","","",""',
		'"101000018","108","ERR","","","100014506","105","4","0004","LV-4242","100032612","1999.03.19","2021.06.30","","Y","Y","""4"", Ipiķu pag., Valmieras nov., LV-4242","","","",""',
	],
	[VARIS_TABLES.Street]: [
		PLACE_HEADER,
		'"100408201","107","Ozolu iela","100193180","106","Y","252","EKS","Ozolu iela","1999.03.16","2021.06.30","","","Ozolu iela, Valmiermuiža, Valmieras pag., Valmieras nov."',
		'"100408804","107","Bauskas iela","100110940","106","Y","252","EKS","Bauskas iela","1998.12.21","2021.06.30","","","Bauskas iela, Bārbele, Bārbeles pag., Bauskas nov."',
		'"100378680","107","Atpūtas iela","100003526","104","Y","252","EKS","Atpūtas iela","2003.04.28","2021.06.30","","","Atpūtas iela, Līvāni, Līvānu nov."',
		'"100306223","107","Krišjāņa Barona iela","100003003","104","Y","252","EKS","Krišjāņa Barona iela","1999.03.16","2025.05.15","","","Krišjāņa Barona iela, Rīga"',
		'"100328634","107","Bērzu iela","100003044","104","Y","252","EKS","Bērzu iela","1999.03.16","2021.06.30","","","Bērzu iela, Liepāja"',
	],
	[VARIS_TABLES.Village]: [
		PLACE_HEADER,
		'"100193180","106","Valmiermuiža","100014635","105","Y","252","EKS","Valmiermuiža","1999.03.16","2021.06.30","","","Valmiermuiža, Valmieras pag., Valmieras nov."',
		'"100110940","106","Bārbele","100010548","105","Y","252","EKS","Bārbele","1999.03.16","2026.03.18","","","Bārbele, Bārbeles pag., Bauskas nov."',
		'"100140040","106","Kombuļi","100011902","105","Y","252","EKS","Kombuļi","1999.03.16","2026.08.17","","","Kombuļi, Kombuļu pag., Krāslavas nov."',
		'"100188041","106","Tiņģere","100013963","105","Y","252","EKS","Tiņģere","1999.03.16","2022.09.19","","","Tiņģere, Īves pag., Talsu nov."',
	],
	[VARIS_TABLES.Parish]: [
		PLACE_HEADER,
		'"100015122","105","Vecates pag.","100016647","113","Y","252","EKS","Vecates pagasts","1999.03.16","2025.07.21","","0054630","Vecates pag., Valmieras nov."',
		'"100014635","105","Valmieras pag.","100016647","113","Y","252","EKS","Valmieras pagasts","1999.03.16","2025.07.21","","0054620","Valmieras pag., Valmieras nov."',
		'"100010548","105","Bārbeles pag.","100016575","113","Y","252","EKS","Bārbeles pagasts","1999.03.16","2025.05.19","","0025400","Bārbeles pag., Bauskas nov."',
		'"100011902","105","Kombuļu pag.","100016743","113","Y","252","EKS","Kombuļu pagasts","1999.03.16","2026.08.20","","0032530","Kombuļu pag., Krāslavas nov."',
		'"100011228","105","Bikstu pag.","100016622","113","Y","252","EKS","Bikstu pagasts","1999.03.16","2025.07.19","","0028450","Bikstu pag., Dobeles nov."',
		'"100013963","105","Īves pag.","100016390","113","Y","252","EKS","Īves pagasts","1999.03.16","2025.07.22","","0051450","Īves pag., Talsu nov."',
		'"100014602","105","Sēļu pag.","100016647","113","Y","252","EKS","Sēļu pagasts","1999.03.16","2025.07.21","","0054580","Sēļu pag., Valmieras nov."',
		'"100014506","105","Ipiķu pag.","100016647","113","Y","252","EKS","Ipiķu pagasts","1999.03.16","2025.07.21","","0054450","Ipiķu pag., Valmieras nov."',
	],
	[VARIS_TABLES.Municipality]: [
		PLACE_HEADER,
		'"100016647","113","Valmieras nov.","100000000","101","Y","252","EKS","Valmieras novads","2021.07.01","2021.06.30","","0054000","Valmieras nov."',
		'"100016575","113","Bauskas nov.","100000000","101","Y","252","EKS","Bauskas novads","2021.07.01","2026.03.30","","0025000","Bauskas nov."',
		'"100016743","113","Krāslavas nov.","100000000","101","Y","252","EKS","Krāslavas novads","2021.07.01","2026.08.20","","0032000","Krāslavas nov."',
		'"100015243","113","Līvānu nov.","100000000","101","Y","252","EKS","Līvānu novads","1999.12.25","2025.04.07","","0036000","Līvānu nov."',
		'"100016622","113","Dobeles nov.","100000000","101","Y","252","EKS","Dobeles novads","2021.07.01","2021.06.30","","0028000","Dobeles nov."',
		'"100016390","113","Talsu nov.","100000000","101","Y","252","EKS","Talsu novads","2021.07.01","2021.06.30","","0051000","Talsu nov."',
		'"100016470","113","Ķekavas nov.","100000000","101","Y","252","EKS","Ķekavas novads","2021.07.01","2021.06.30","","0034000","Ķekavas nov."',
	],
	[VARIS_TABLES.City]: [
		PLACE_HEADER,
		'"100003526","104","Līvāni","100015243","113","Y","252","EKS","Līvāni","1999.03.16","2026.09.15","","0036200","Līvāni, Līvānu nov."',
		'"100003003","104","Rīga","100000000","101","Y","252","EKS","Rīga","1999.03.16","2025.04.14","","0001000","Rīga"',
		'"100003831","104","Ķekava","100016470","113","Y","252","EKS","Ķekava","2022.07.01","2022.07.01","","0034220","Ķekava, Ķekavas nov."',
		'"100003044","104","Liepāja","100000000","101","Y","252","EKS","Liepāja","1999.03.16","2025.04.15","","0005000","Liepāja"',
	],
}

async function writeTables(): Promise<void> {
	for (const [table, lines] of Object.entries(TABLES)) {
		await writeLocalTextFile(BOM + lines.join("\r\n") + "\r\n", scratch.path(table))
	}
}

async function run(options: { country?: string; limit?: number } = {}) {
	await writeTables()

	return await runAdapter({
		adapter: createVarisAdapter(),
		adapterOptions: { inputPath: scratch.path, ...options },
		outputDir: scratch.path("out"),
		corpusVersion: "0.1.0",
	})
}

async function rows() {
	return await readCanonicalRows(scratch.path("out"), LV_VARIS_ADAPTER_ID)
}

describe("lv-varis adapter against records of the 2026-09-30 edition", () => {
	it("emits each active address as the register writes it, and counts every refusal", async () => {
		const manifest = await run()

		expect(manifest.yielded).toBe(9)

		expect(manifest.dropped).toEqual({
			[VarisRefusal.Erroneous]: 1,
			[VarisRefusal.NamedHouseOnStreet]: 1,
			[VarisRefusal.Removed]: 1,
		})

		const emitted = await rows()

		expect(emitted.map((row) => row.raw)).toEqual([
			'"Riņņi", Vecates pag., Valmieras nov., LV-4211',
			"Ozolu iela 18, Valmiermuiža, Valmieras pag., Valmieras nov., LV-4219",
			'"Vilidža ", Kombuļi, Kombuļu pag., Krāslavas nov., LV-5656',
			"Atpūtas iela 4, Līvāni, Līvānu nov., LV-5316",
			"Krišjāņa Barona iela 1, Rīga, LV-1050",
			'"Stacija "Biksti"", Bikstu pag., Dobeles nov., LV-3713',
			'"Ilgas", Tiņģere, Īves pag., Talsu nov., LV-3261',
			'"Ierasti", Ķekava, Ķekavas nov., LV-2123',
			"Bērzu iela 19 k-1, Liepāja, LV-3411",
		])

		expect(emitted.every((row) => row.license === LV_VARIS_LICENSE && row.country === "LV")).toBe(true)
		expect(emitted.every((row) => row.surface === SurfaceOrigin.Attested)).toBe(true)
		expect(emitted[0]!.source_id).toBe("lv-varis-101000034")
	})

	it("labels a street address in a village", async () => {
		await run()

		const row = (await rows()).find((r) => r.source_id === "lv-varis-101003948")

		expect(row?.components).toEqual({
			street: "Ozolu iela",
			house_number: "18",
			dependent_locality: "Valmiermuiža",
			locality: "Valmieras pag.",
			region: "Valmieras nov.",
			postcode: "LV-4219",
		})
	})

	it("labels a named house as a venue without its quotes, and a state city with no region", async () => {
		await run()

		const emitted = await rows()

		expect(emitted.find((r) => r.source_id === "lv-varis-101000034")?.components).toEqual({
			venue: "Riņņi",
			locality: "Vecates pag.",
			region: "Valmieras nov.",
			postcode: "LV-4211",
		})

		expect(emitted.find((r) => r.source_id === "lv-varis-102748756")?.components.venue).toBe('Stacija "Biksti"')
		expect(emitted.find((r) => r.source_id === "lv-varis-101165372")?.components.venue).toBe("Vilidža")

		expect(emitted.find((r) => r.source_id === "lv-varis-101844053")?.components).toEqual({
			street: "Krišjāņa Barona iela",
			house_number: "1",
			locality: "Rīga",
			postcode: "LV-1050",
		})

		expect(emitted.find((r) => r.source_id === "lv-varis-106849064")?.components.house_number).toBe("19 k-1")
	})

	it("aligns every component to its own place in the line", async () => {
		await run()

		for (const row of await rows()) {
			const aligned = alignRow(row, { maxEditDistance: 0 })

			expect(aligned.kind).toBe("labeled")

			if (aligned.kind !== "labeled") continue

			const { span_tags: tags = [], span_starts: starts = [], span_ends: ends = [] } = aligned.row

			expect(tags).toHaveLength(Object.keys(row.components).length)

			for (const [index, tag] of tags.entries()) {
				const text = row.raw.slice(starts[index], ends[index])

				expect(text).toBe(row.components[tag])
			}
		}
	})

	it("honors the limit and refuses another country", async () => {
		expect((await run({ limit: 2 })).yielded).toBe(2)
		await expect(run({ country: "EE" })).rejects.toThrow(/LV/u)
	})
})

describe("readVarisBuilding", () => {
	const record: VarisRecord = {
		KODS: "1",
		TIPS_CD: "108",
		STATUSS: "EKS",
		VKUR_CD: "20",
		VKUR_TIPS: "105",
		NOSAUKUMS: "Kalnieši",
		ATRIB: "LV-2164",
		STD: '"Kalnieši", Ādažu pag., Ādažu nov., LV-2164',
	}

	const parish: VarisPlace = { type: "105", name: "Ādažu pag.", parentCode: "30", active: true }
	const municipality: VarisPlace = { type: "113", name: "Ādažu nov.", parentCode: "100000000", active: true }

	it("reads a rural named house and its address type", () => {
		const reading = readVarisBuilding(
			record,
			new Map([
				["20", parish],
				["30", municipality],
			])
		)

		expect("admitted" in reading && reading.addressType).toBe(VarisAddressType.ParishNamedHouse)
	})

	it("refuses an unresolved parent, an inactive ancestor and a standard form it cannot compose", () => {
		expect(readVarisBuilding(record, new Map([["20", parish]]))).toEqual({
			refused: VarisRefusal.ParentUnresolved,
		})

		expect(
			readVarisBuilding(
				record,
				new Map([
					["20", parish],
					["30", { ...municipality, active: false }],
				])
			)
		).toEqual({ refused: VarisRefusal.AncestorInactive })

		expect(
			readVarisBuilding(
				{ ...record, STD: '"Kalnieši", Ādažu nov., LV-2164' },
				new Map([
					["20", parish],
					["30", municipality],
				])
			)
		).toEqual({ refused: VarisRefusal.StandardFormMismatch })
	})

	it("refuses a record with no postcode", () => {
		expect(
			readVarisBuilding(
				{ ...record, ATRIB: "" },
				new Map([
					["20", parish],
					["30", municipality],
				])
			)
		).toEqual({ refused: VarisRefusal.PostcodeAbsent })
	})
})
