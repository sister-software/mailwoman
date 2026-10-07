/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { removePathIfPresent } from "@mailwoman/core/fs/writers"
import { workspacePath } from "@mailwoman/core/paths"
import { describe, expect, it } from "vitest"

import {
	ALAND_MUNICIPALITIES,
	composeRyhtiHouseNumber,
	countryOfFinnishMunicipality,
	createRyhtiAdapter,
	RYHTI_ADAPTER_ID,
} from "#fi/adapters/ryhti/adapter"
import { runAdapter } from "#runner"
import { readCanonicalRows, useScratchDir } from "#test-kit"

const scratch = useScratchDir("ryhti")

const fixtureCSV = workspacePath("corpus", "fixtures", "ryhti", "sample.csv")

function run(country?: string) {
	return runAdapter({
		adapter: createRyhtiAdapter(),
		adapterOptions: { inputPath: fixtureCSV, ...(country ? { country } : {}) },
		outputDir: scratch.path,
		corpusVersion: "0.1.0",
	})
}

describe("ryhti adapter against fixture sample.csv", () => {
	it("emits one row per published record under SYKE's CC BY 4.0", async () => {
		// Fourteen records, one of which names no street in either language and is refused.
		// The two records that publish a Finnish and a differing Swedish name emit the Finnish one.
		const manifest = await run()

		expect(manifest.yielded).toBe(13)

		const rows = await readCanonicalRows(scratch.path, RYHTI_ADAPTER_ID)

		expect(rows).toHaveLength(13)
		expect(rows.every((r) => r.license === "CC-BY-4.0")).toBe(true)
		expect(rows.every((r) => r.source === RYHTI_ADAPTER_ID)).toBe(true)
		expect(rows.every((r) => Boolean(r.components.street))).toBe(true)
	})

	it("reads Åland as its own jurisdiction from the municipality number", async () => {
		await run()

		const rows = await readCanonicalRows(scratch.path, RYHTI_ADAPTER_ID)
		const byCountry = new Map<string, number>()

		for (const row of rows) {
			byCountry.set(row.country, (byCountry.get(row.country) ?? 0) + 1)
		}

		expect(Object.fromEntries(byCountry)).toEqual({ FI: 8, AX: 5 })
	})

	it.each([
		["478", "AX"],
		["170", "AX"],
		["766", "AX"],
		["035", "AX"],
		["35", "AX"],
		["508", "FI"],
		["179", "FI"],
		["091", "FI"],
		["", "FI"],
	])("countryOfFinnishMunicipality(%s) is %s", (code, expected) => {
		expect(countryOfFinnishMunicipality(code)).toBe(expected)
	})

	it("covers all sixteen Åland municipalities", () => {
		expect(ALAND_MUNICIPALITIES.size).toBe(16)
		expect([...ALAND_MUNICIPALITIES].every((code) => code.length === 3)).toBe(true)
	})

	it("composes the house number from the part columns rather than the address text", async () => {
		await run()

		const rows = await readCanonicalRows(scratch.path, RYHTI_ADAPTER_ID)
		const numberOf = (street: string) => rows.find((r) => r.components.street === street)?.components.house_number

		// A lettered number, a range, and a range whose second half holds the letter.
		expect(numberOf("Kiviperäntie")).toBe("41a")
		expect(numberOf("Majvikintie")).toBe("2-26")
		expect(numberOf("Koppelontie")).toBe("184-183b")
		expect(rows.find((r) => r.components.street === "Kiviperäntie")?.raw).toBe("Kiviperäntie 41a, FI-93800 KUUSAMO")
	})

	it.each([
		[{ number_part_of_address_number: "41", subdivision_letter_of_address_number: "a" }, "41a"],
		[{ number_part_of_address_number: "2", number_part_of_address_number2: "26" }, "2-26"],
		[
			{
				number_part_of_address_number: "184",
				number_part_of_address_number2: "183",
				subdivision_letter_of_address_number2: "b",
			},
			"184-183b",
		],
		// A second letter with no second number still opens the hyphenated half,
		// because the publisher populated it.
		[{ number_part_of_address_number: "17", subdivision_letter_of_address_number2: "a" }, "17-a"],
		[{ number_part_of_address_number: "" }, ""],
		// A row with no first number part has no number at all, whatever the second pair states.
		[{ number_part_of_address_number: "", number_part_of_address_number2: "26" }, ""],
	])("composeRyhtiHouseNumber(%o) is %s", (parts, expected) => {
		expect(composeRyhtiHouseNumber(parts)).toBe(expected)
	})

	it("emits a named place with no house number rather than fabricating one", async () => {
		await run()

		const rows = await readCanonicalRows(scratch.path, RYHTI_ADAPTER_ID)
		const named = rows.find((r) => r.components.street === "Kalliosaari")

		expect(named?.components.house_number).toBeUndefined()
		expect(named?.raw).toBe("Kalliosaari, FI-40640 JYVÄSKYLÄ")
	})

	it("refuses a row whose address text holds a bare number and names no street", async () => {
		await run()

		const rows = await readCanonicalRows(scratch.path, RYHTI_ADAPTER_ID)

		// `address_swe` reads `232` with an empty `address_name_swe`, and `address_name_fin`
		// is empty too, so the row has no street in either language.
		expect(rows.some((r) => r.components.postcode === "04460")).toBe(false)
	})

	it("emits the Finnish name alone for a record whose address_name_swe is empty", async () => {
		await run()

		const rows = await readCanonicalRows(scratch.path, RYHTI_ADAPTER_ID)
		const haltiattarentie = rows.filter((r) => r.source_id.startsWith("ryhti-00001099-a046-4735-b16f-f152bbb2b855"))

		// `address_swe` is `1`, a bare number, and `address_name_swe` is empty,
		// so the record emits only the Finnish surface.
		expect(haltiattarentie).toHaveLength(1)
		expect(haltiattarentie[0]!.locale).toBe("fi-FI")
	})

	it("emits one row for a bilingual mainland record, from its Finnish columns", async () => {
		await run()

		const rows = await readCanonicalRows(scratch.path, RYHTI_ADAPTER_ID)
		const bilingual = rows.filter((r) => r.source_id === "ryhti-00002202-2423-4045-a3b4-237aec4aacaf")

		// The record publishes `Maarintie 70` with `SILTAKYLÄ` and `Maarvägen 70` with `BROBY`.
		expect(bilingual).toHaveLength(1)
		expect(bilingual[0]!.locale).toBe("fi-FI")
		expect(bilingual[0]!.raw).toBe("Maarintie 70, FI-49220 SILTAKYLÄ")
		expect(rows.some((r) => r.raw.includes("Maarvägen"))).toBe(false)
	})

	it("reads a mainland record that names only its Swedish columns as sv-FI", async () => {
		await run()

		const rows = await readCanonicalRows(scratch.path, RYHTI_ADAPTER_ID)
		const sipoo = rows.filter((r) => r.components.street === "Luhtivägen")

		// Sipoo is Swedish-speaking, so the record populates `address_name_swe` and leaves
		// `address_name_fin` empty, and the Swedish postal place `SIBBO` stands with it.
		expect(sipoo).toHaveLength(1)
		expect(sipoo[0]!.country).toBe("FI")
		expect(sipoo[0]!.locale).toBe("sv-FI")
		expect(sipoo[0]!.raw).toBe("Luhtivägen 2, FI-04130 SIBBO")
	})

	it("reads an Åland row's Finnish columns as Swedish, because that is what they hold", async () => {
		await run()

		const rows = await readCanonicalRows(scratch.path, RYHTI_ADAPTER_ID)

		// `address_fin` reads `Solbackastigen 7` and `address_swe` is empty on this Hammarland row.
		const hammarland = rows.find((r) => r.components.street === "Solbackastigen")

		expect(hammarland?.country).toBe("AX")
		expect(hammarland?.locale).toBe("sv-AX")
		expect(hammarland?.raw).toBe("Solbackastigen 7, AX-22240 HAMMARLAND")

		// A row whose two name columns agree emits once rather than twice.
		expect(rows.filter((r) => r.components.street === "Skogshyddsvägen")).toHaveLength(1)

		expect(rows.find((r) => r.components.street === "Östernäsvägen")?.raw).toBe("Östernäsvägen 24c, AX-22100 MARIEHAMN")
	})

	it("names the language of the emitted name in the locale", async () => {
		await run()

		const rows = await readCanonicalRows(scratch.path, RYHTI_ADAPTER_ID)
		const byLocale = new Map<string, number>()

		for (const row of rows) {
			byLocale.set(row.locale ?? "", (byLocale.get(row.locale ?? "") ?? 0) + 1)
		}

		expect(Object.fromEntries(byLocale)).toEqual({ "fi-FI": 7, "sv-FI": 1, "sv-AX": 5 })
		// Every Åland row is Swedish, and no mainland row is labeled Åland's locale.
		expect(rows.every((r) => (r.country === "AX" ? r.locale === "sv-AX" : r.locale !== "sv-AX"))).toBe(true)
	})

	it("keeps only Åland's rows when --country AX is given", async () => {
		const manifest = await run("AX")

		expect(manifest.yielded).toBe(5)

		const rows = await readCanonicalRows(scratch.path, RYHTI_ADAPTER_ID)

		expect(rows.every((r) => r.country === "AX")).toBe(true)
		expect(rows.every((r) => r.locale === "sv-AX")).toBe(true)

		expect(rows.map((r) => r.raw).toSorted()).toEqual([
			"Erikavägen 3, AX-22120 MARIEHAMN",
			"Skogshyddsvägen 11, AX-22100 MARIEHAMN",
			"Solbackastigen 7, AX-22240 HAMMARLAND",
			"Sottungavägen 10, AX-22720 SOTTUNGA",
			"Östernäsvägen 24c, AX-22100 MARIEHAMN",
		])
	})

	it("keeps only mainland rows when --country FI is given", async () => {
		const manifest = await run("FI")

		expect(manifest.yielded).toBe(8)

		const rows = await readCanonicalRows(scratch.path, RYHTI_ADAPTER_ID)

		expect(rows.every((r) => r.country === "FI")).toBe(true)
	})

	it("rejects a jurisdiction the dataset does not cover", async () => {
		await expect(run("SE")).rejects.toThrow(/the dataset covers FI, AX/)
	})

	it("honors opts.limit", async () => {
		const manifest = await run()

		expect(manifest.yielded).toBe(13)

		const capped = await runAdapter({
			adapter: createRyhtiAdapter(),
			adapterOptions: { inputPath: fixtureCSV, limit: 3 },
			outputDir: scratch.path,
			corpusVersion: "0.1.0",
		})

		expect(capped.yielded).toBe(3)
	})

	it("source_id uses SYKE's own address key", async () => {
		await run()

		const rows = await readCanonicalRows(scratch.path, RYHTI_ADAPTER_ID)

		expect(rows[0]!.source_id).toBe("ryhti-00000ad0-ea0e-4f57-97d7-23a2f63c859e")
		expect(new Set(rows.map((r) => r.source_id)).size).toBe(rows.length)
	})

	it("two runs over the same CSV produce identical sha256", async () => {
		const a = await run()

		await removePathIfPresent(scratch.path(RYHTI_ADAPTER_ID))

		const b = await run()

		expect(a.sha256).toBe(b.sha256)
	})
})
