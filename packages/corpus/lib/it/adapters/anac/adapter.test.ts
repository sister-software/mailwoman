/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { workspacePath } from "@mailwoman/core/paths"
import { describe, expect, it } from "vitest"

import {
	ANACRefusal,
	createITANACAdapter,
	IT_ANAC_ADAPTER_ID,
	IT_ANAC_LICENSE,
	isPlaceholderValue,
	normalizeANACStreetLine,
	readANACParty,
} from "#it/adapters/anac/adapter"
import { runAdapter } from "#runner"
import { readCanonicalRows, useScratchDir } from "#test-kit"

const scratch = useScratchDir("it-anac")

/**
 * Twelve releases of the 9,405 in ANAC's 2025 edition, as the publisher's `2025.jsonl.gz`
 * holds them once decompressed, keeping each release's `ocid` and `parties` verbatim
 * and dropping the `tender`, `awards` and `contracts` objects the adapter never reads.
 *
 * The twelve were selected to exercise one street-line shape each: a plain `VIA GIUSEPPE GARIBALDI
 * 75`, a subdivided `VIA PASTRENGO 2/TER`, a slash range `16/18`, a spaced civic marker `N. 4`, a
 * glued one `N.68`, a `SNC` tail, a trailing locality `CORSO ITALIA, 29 FIRENZE`, a line with no
 * number at all, a kilometre point `S.S. 7 APPIA KM 671`, a qualifier after the number `VIA
 * CIRCONVALLAZIONE, 1 PARCO IDROSCALO SEGRATE`, the `N.A.` postcode placeholder, the Brazilian
 * `01238-000` on an Italian cultural institute abroad, an organization name holding a comma, and a
 * party whose name is a fiscal code rather than a name.
 *
 * The source file's sha256 is `8169ab8e654bd6aae6c1cb00d3d8d8f3e8e63f4e765565e6f952b62575557350`.
 */
const fixtureJSONL = workspacePath("corpus", "fixtures", "anac", "sample.jsonl")

async function run(options: { country?: string; limit?: number } = {}) {
	return await runAdapter({
		adapter: createITANACAdapter(),
		adapterOptions: { inputPath: fixtureJSONL, ...options },
		outputDir: scratch.path,
		corpusVersion: "0.1.0",
	})
}

describe("it-anac adapter against fixture sample.jsonl", () => {
	it("emits one row per admitted party under the licence the register elected", async () => {
		const manifest = await run()

		// 21 of the fixture's 34 party objects: 11 suppliers hold a role the adapter does not read,
		// one buyer's street line holds an unplaced number and one payer's postcode is a Brazilian CEP.
		expect(manifest.yielded).toBe(21)

		const rows = await readCanonicalRows(scratch.path, IT_ANAC_ADAPTER_ID)

		expect(rows).toHaveLength(21)
		expect(rows.every((row) => row.license === IT_ANAC_LICENSE)).toBe(true)
		expect(rows.every((row) => row.source === IT_ANAC_ADAPTER_ID)).toBe(true)
		expect(rows.every((row) => row.country === "IT")).toBe(true)
		expect(rows.every((row) => row.locale === "it-IT")).toBe(true)
		expect(rows.every((row) => Boolean(row.components.locality))).toBe(true)
	})

	it("writes the house number after the street, space-joined, as Italy does", async () => {
		await run()

		const rows = await readCanonicalRows(scratch.path, IT_ANAC_ADAPTER_ID)
		const parma = rows.find((row) => row.components.locality === "PARMA")

		expect(parma?.components.street).toBe("VIA GIUSEPPE GARIBALDI")
		expect(parma?.components.house_number).toBe("75")
		expect(parma?.raw).toBe("AGENZIA INTERREGIONALE PER IL FIUME PO AIPO, VIA GIUSEPPE GARIBALDI 75, 43121 PARMA")
	})

	it("keeps a subdivided number whole", async () => {
		await run()

		const rows = await readCanonicalRows(scratch.path, IT_ANAC_ADAPTER_ID)

		expect(rows.find((row) => row.components.locality === "MONCALIERI")?.components.house_number).toBe("2/TER")
		expect(rows.find((row) => row.components.street === "VIA FILIPPO PALUMBO")?.components.house_number).toBe("16/18")
	})

	it("never lets the publisher's N.A. placeholder reach a postcode", async () => {
		await run()

		const rows = await readCanonicalRows(scratch.path, IT_ANAC_ADAPTER_ID)

		expect(rows.some((row) => row.components.postcode === "N.A.")).toBe(false)

		// The buyer whose published postalCode is `N.A.` keeps its street and locality.
		const sanGiuliano = rows.find((row) => row.components.venue === "COMUNE DI SAN GIULIANO MILANESE")

		expect(sanGiuliano?.components.postcode).toBeUndefined()
		expect(sanGiuliano?.raw).toBe("COMUNE DI SAN GIULIANO MILANESE, VIA DE NICOLA 2, SAN GIULIANO MILANESE")
	})

	it("reads no supplier party, because that role publishes no address", async () => {
		await run()

		const rows = await readCanonicalRows(scratch.path, IT_ANAC_ADAPTER_ID)

		// Every supplier name in the fixture, read from the fixture rather than invented.
		const suppliers = [
			"DIZETA INGEGNERIA STUDIO ASSOCIATO",
			"GF STRADE S.R.L.",
			"ZINI ELIO SRL",
			"CO.GE.FA. S.R.L.",
			"FIRMA SRL",
			"ITALIANA PETROLI S.P.A.",
			"BIO COSTRUZIONI SRL",
			"STUDIO TECNICO ING. MOLINARO",
			"EREDI CIRILLO LUIGI SAS DI PELLEGRINO ROSA",
			"MARVIN ACUSTICA SRL",
			"GIUDICI SPA",
		]

		for (const supplier of suppliers) {
			expect(rows.some((row) => row.components.venue === supplier)).toBe(false)
		}
	})

	it("honors limit", async () => {
		const manifest = await run({ limit: 3 })

		expect(manifest.yielded).toBe(3)
	})

	it("refuses a country it does not publish", async () => {
		await expect(run({ country: "FR" })).rejects.toThrow(/it-anac/)
	})
})

describe("readANACParty", () => {
	it("refuses a role the register does not name", () => {
		const reading = readANACParty({
			name: "DIZETA INGEGNERIA STUDIO ASSOCIATO",
			roles: ["supplier"],
			address: { locality: "PARMA", postalCode: "43121", streetAddress: "VIA GIUSEPPE GARIBALDI 75" },
		})

		expect(reading).toEqual({ refused: ANACRefusal.RoleNotAdmitted })
	})

	it("refuses a name in the Surname, Firstname form a natural person's name takes", () => {
		const reading = readANACParty({
			name: "Tausendfreund, Bettina",
			roles: ["buyer"],
			address: { locality: "PARMA", postalCode: "43121", streetAddress: "VIA GIUSEPPE GARIBALDI 75" },
		})

		expect(reading).toEqual({ refused: ANACRefusal.NamePersonalForm })
	})

	it("admits an organization name that holds a comma", () => {
		const reading = readANACParty({
			name: "PARCO NAZIONALE DEL CILENTO, VALLO DI DIANO E ALBURNI",
			roles: ["buyer"],
			address: { locality: "VALLO DELLA LUCANIA", postalCode: "84078", streetAddress: "VIA FILIPPO PALUMBO 16/18" },
		})

		expect("admitted" in reading).toBe(true)
	})

	it("refuses a postcode that is not an Italian CAP", () => {
		const reading = readANACParty({
			name: "ISTITUTO ITALIANO DI CULTURA DI SAN PAOLO",
			roles: ["payer"],
			address: { postalCode: "01238-000" },
		})

		expect(reading).toEqual({ refused: ANACRefusal.PostcodeNotCAP })
	})

	it("refuses a countryName naming another country", () => {
		const reading = readANACParty({
			name: "AMBASCIATA",
			roles: ["payer"],
			address: { locality: "PARIS", postalCode: "75008", countryName: "FRANCE", streetAddress: "RUE DE VARENNE 1" },
		})

		expect(reading).toEqual({ refused: ANACRefusal.CountryNotItaly })
	})

	it("refuses a street line whose number the split could not place", () => {
		const reading = readANACParty({
			name: "CAP HOLDING S.P.A.",
			roles: ["buyer"],
			address: {
				locality: "SEGRATE",
				postalCode: "20054",
				streetAddress: "VIA CIRCONVALLAZIONE, 1 PARCO IDROSCALO SEGRATE",
			},
		})

		expect(reading).toEqual({ refused: ANACRefusal.StreetNumberUnplaced })
	})

	it("refuses a kilometre point rather than reading it as a house number", () => {
		const reading = readANACParty({
			name: "STAZIONE AEROMOBILI DELLA MARINA MILITARE",
			roles: ["buyer"],
			address: { locality: "GROTTAGLIE", postalCode: "74023", streetAddress: "S.S. 7 APPIA KM 671" },
		})

		expect(reading).toEqual({ refused: ANACRefusal.StreetNumberUnplaced })
	})

	it("keeps a party name holding no letter out of venue", () => {
		const reading = readANACParty({
			name: "06413980969",
			roles: ["payer"],
			address: { locality: "MEDA", postalCode: "20036", streetAddress: "VIA TRE VENEZIE 63" },
		})

		expect(reading).toEqual({
			admitted: expect.objectContaining({
				raw: "VIA TRE VENEZIE 63, 20036 MEDA",
			}),
		})

		expect("admitted" in reading && reading.admitted.components.venue).toBeUndefined()
	})

	it("refuses a row that carries a locality alone", () => {
		const reading = readANACParty({
			name: "0",
			roles: ["payer"],
			address: { locality: "ROMA", postalCode: "N.A." },
		})

		expect(reading).toEqual({ refused: ANACRefusal.ComponentsTooFew })
	})
})

describe("normalizeANACStreetLine", () => {
	it("removes a trailing copy of the publisher's own locality", () => {
		expect(normalizeANACStreetLine("CORSO ITALIA, 29 FIRENZE", "FIRENZE")).toBe("CORSO ITALIA, 29")
	})

	it("leaves a line that is the locality itself", () => {
		expect(normalizeANACStreetLine("FIRENZE", "FIRENZE")).toBe("FIRENZE")
	})

	it("removes a civic marker whether it is spaced or glued to the number", () => {
		expect(normalizeANACStreetLine("PIAZZA GUGLIELMO MARCONI N. 4", "MONTEROTONDO")).toBe("PIAZZA GUGLIELMO MARCONI 4")
		expect(normalizeANACStreetLine("VIA ROMA N.68", "MONTELONGO")).toBe("VIA ROMA 68")
	})

	it("leaves a street name whose own last letter is the marker's", () => {
		expect(normalizeANACStreetLine("VIA THOMAS ALVA EDISON 10/D", "SESTO FIORENTINO")).toBe(
			"VIA THOMAS ALVA EDISON 10/D"
		)
	})

	it("removes a senza-numero tail", () => {
		expect(normalizeANACStreetLine("VIALE DI MARINO SNC", "CIAMPINO")).toBe("VIALE DI MARINO")
		expect(normalizeANACStreetLine("VIALE DELLE INDUSTRIE SN", "MARINO")).toBe("VIALE DELLE INDUSTRIE")
	})
})

describe("isPlaceholderValue", () => {
	it("reads the publisher's N.A. as absent", () => {
		expect(isPlaceholderValue("N.A.")).toBe(true)
		expect(isPlaceholderValue("n.a.")).toBe(true)
	})

	it("reads a value holding no letter and no digit as absent", () => {
		expect(isPlaceholderValue("--")).toBe(true)
		expect(isPlaceholderValue(" ")).toBe(true)
	})

	it("reads a published value as present", () => {
		expect(isPlaceholderValue("43121")).toBe(false)
		expect(isPlaceholderValue("NAPOLI")).toBe(false)
	})
})
