/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { writeLocalFile } from "@mailwoman/core/fs/writers"
import { describe, expect, it } from "vitest"

import {
	createGLEIFAdapter,
	GLEIF_ADAPTER_ID,
	GLEIF_LICENSE,
	GLEIFAddressBlock,
	type GLEIFRecord,
	GLEIFRefusal,
	headquartersRepeatsLegal,
	houseNumberLeadsStreet,
	normalizeGLEIFStreetLine,
	readGLEIFAddress,
	readGLEIFEntity,
} from "#adapters/gleif/adapter"
import { runAdapter } from "#runner"
import { readCanonicalRows, useScratchDir } from "#test-kit"

const scratch = useScratchDir("gleif-lei")

const ADDRESS_FIELDS = [
	"FirstAddressLine",
	"AddressNumber",
	"AddressNumberWithinBuilding",
	"MailRouting",
	"AdditionalAddressLine.1",
	"AdditionalAddressLine.2",
	"AdditionalAddressLine.3",
	"City",
	"Region",
	"Country",
	"PostalCode",
] as const

type AddressFields = Partial<Record<(typeof ADDRESS_FIELDS)[number], string>>

/**
 * One LEI-CDF record holding only the columns the adapter reads.
 *
 * The values in the cases below are copied from the 2026-10-03 08:00 golden copy
 * and its last-day delta, with the LEI dropped.
 */
function record(entity: {
	name: string
	category?: string
	legalForm?: string
	otherLegalForm?: string
	legal: AddressFields
	headquarters?: AddressFields
}): GLEIFRecord {
	const out: Record<string, string> = {
		LEI: "TEST",
		"Entity.LegalName": entity.name,
		"Entity.EntityCategory": entity.category ?? "GENERAL",
		"Entity.LegalForm.EntityLegalFormCode": entity.legalForm ?? "",
		"Entity.LegalForm.OtherLegalForm": entity.otherLegalForm ?? "",
	}

	for (const field of ADDRESS_FIELDS) {
		out[`Entity.LegalAddress.${field}`] = entity.legal[field] ?? ""
		out[`Entity.HeadquartersAddress.${field}`] = (entity.headquarters ?? entity.legal)[field] ?? ""
	}

	return out
}

const SLADOVNA = record({
	name: "SLADOVŇA, a.s. Michalovce",
	legal: {
		FirstAddressLine: "Močarianska 14",
		City: "Michalovce",
		Region: "SK-KI",
		Country: "SK",
		PostalCode: "071 01",
	},
})

const TWO_SIGMA = record({
	name: "TWO SIGMA INVESTMENTS, LP",
	legal: {
		FirstAddressLine: "2711 Centerville Road",
		City: "Wilmington",
		Region: "US-DE",
		Country: "US",
		PostalCode: "19808",
	},
	headquarters: {
		FirstAddressLine: "100 AVENUE OF THE AMERICAS",
		City: "NEW YORK",
		Region: "US-NY",
		Country: "US",
		PostalCode: "10013",
	},
})

function admitted(reading: ReturnType<typeof readGLEIFAddress>) {
	if (!("admitted" in reading)) throw new Error(`refused: ${reading.refused}`)

	return reading.admitted
}

describe("readGLEIFEntity", () => {
	it("refuses the sole-proprietor category", () => {
		const entity = record({
			name: "Ondi Tamás Előd egyéni vállalkozó",
			category: "SOLE_PROPRIETOR",
			legalForm: "BJ8Q",
			legal: { FirstAddressLine: "Fő utca 1", City: "Budapest", Country: "HU" },
		})

		expect(readGLEIFEntity(entity)).toBe(GLEIFRefusal.SoleProprietorCategory)
	})

	it("refuses a free-text legal form that states a sole trader under a general category", () => {
		const entity = record({
			name: "GAONI BARBARA",
			legalForm: "8888",
			otherLegalForm: "Ditta Individuale",
			legal: { FirstAddressLine: "VIA ROMA 1", City: "ROMA", Country: "IT" },
		})

		expect(readGLEIFEntity(entity)).toBe(GLEIFRefusal.SoleProprietorFormText)
	})

	it("admits a company whose name holds a comma before its legal suffix", () => {
		expect(readGLEIFEntity(TWO_SIGMA)).toBeNull()
		expect(readGLEIFEntity(record({ name: "TELAFORCE, LLC", legal: {} }))).toBeNull()
		expect(readGLEIFEntity(record({ name: "CityRail, a.s.", legal: {} }))).toBeNull()
	})

	it("refuses a legal form the ELF code list names as a sole proprietorship, whatever the category", () => {
		const entity = record({
			name: "H.S. EXPORTS",
			legalForm: "4QIE",
			legal: { FirstAddressLine: "12 MG Road", City: "Mumbai", Country: "IN" },
		})

		expect(readGLEIFEntity(entity)).toBe(GLEIFRefusal.SoleProprietorLegalForm)
	})
})

describe("readGLEIFAddress", () => {
	it("splits a number-last street line and renders the Slovak order", () => {
		const row = admitted(readGLEIFAddress(SLADOVNA, GLEIFAddressBlock.Legal))

		expect(row.components).toEqual({
			venue: "SLADOVŇA, a.s. Michalovce",
			street: "Močarianska",
			house_number: "14",
			postcode: "071 01",
			locality: "Michalovce",
		})

		expect(row.raw).toBe("SLADOVŇA, a.s. Michalovce, Močarianska 14, 071 01 Michalovce")
		expect(row.license).toBe(GLEIF_LICENSE)
		expect(row.source).toBe(GLEIF_ADAPTER_ID)
	})

	it("splits a number-first line and keeps a US state whose code is its written form", () => {
		const row = admitted(readGLEIFAddress(TWO_SIGMA, GLEIFAddressBlock.Headquarters))

		expect(row.components.house_number).toBe("100")
		expect(row.components.street).toBe("AVENUE OF THE AMERICAS")
		expect(row.components.region).toBe("NY")
		expect(row.raw).toBe("TWO SIGMA INVESTMENTS, LP, 100 AVENUE OF THE AMERICAS, NEW YORK, NY 10013")
	})

	it("leaves out a region whose ISO 3166-2 code is not how an address writes it", () => {
		expect(admitted(readGLEIFAddress(SLADOVNA, GLEIFAddressBlock.Legal)).components.region).toBeUndefined()
	})

	it("reads Namibia's code as a country rather than as a placeholder", () => {
		const namibia = record({
			name: "ARYSTEQ UNIT TRUST",
			legal: { FirstAddressLine: "16 Amasoniet Street", City: "Windhoek", Country: "NA", PostalCode: "10005" },
		})

		expect(readGLEIFAddress(namibia, GLEIFAddressBlock.Legal)).not.toEqual({ refused: GLEIFRefusal.CountryAbsent })
	})

	it("refuses a care-of line, which can name a natural person", () => {
		const careOf = record({
			name: "VOLLSVEIEN AS",
			legal: { FirstAddressLine: "c/o: Karianne Løkken", City: "JAR", Country: "NO", PostalCode: "1358" },
		})

		expect(readGLEIFAddress(careOf, GLEIFAddressBlock.Legal)).toEqual({ refused: GLEIFRefusal.CareOfLine })
	})

	it("refuses a digitless first line, which may be a building rather than a street", () => {
		const building = record({
			name: "DUNDEE HOLDINGS LIMITED",
			legal: { FirstAddressLine: "KYDD BUILDING", City: "DUNDEE", Country: "GB", PostalCode: "DD1 1HG" },
		})

		expect(readGLEIFAddress(building, GLEIFAddressBlock.Legal)).toEqual({
			refused: GLEIFRefusal.StreetLineWithoutNumber,
		})
	})

	it("refuses a line holding a number the split cannot place", () => {
		const floor = record({
			name: "LONDON WALL LIMITED",
			legal: {
				FirstAddressLine: "6TH FLOOR 2 LONDON WALL PLACE",
				City: "LONDON",
				Country: "GB",
				PostalCode: "EC2Y 5AU",
			},
		})

		expect(readGLEIFAddress(floor, GLEIFAddressBlock.Legal)).toEqual({ refused: GLEIFRefusal.StreetNumberUnplaced })
	})

	it("refuses a number that numbers a room or a building rather than a premise on a street", () => {
		const tower = record({
			name: "NASPER CAPITAL MANAGEMENT LIMITED",
			legal: { FirstAddressLine: "903 PLATINUM TOWER", City: "DOHA", Country: "QA" },
		})

		const segmented = record({
			name: "KANTHAROS INVESTMENT LIMITED",
			legal: { FirstAddressLine: "CAVES CORPORATE CENTRE, BUILDING 2", City: "PANAMA", Country: "PA" },
		})

		const generic = record({
			name: "Dukhan Real Estate Investment Company",
			legal: { FirstAddressLine: "910 Street", City: "Doha", Country: "QA" },
		})

		expect(readGLEIFAddress(tower, GLEIFAddressBlock.Legal)).toEqual({ refused: GLEIFRefusal.StreetHoldsPremiseWord })

		expect(readGLEIFAddress(segmented, GLEIFAddressBlock.Legal)).toEqual({
			refused: GLEIFRefusal.StreetLineSegmented,
		})

		expect(readGLEIFAddress(generic, GLEIFAddressBlock.Legal)).toEqual({ refused: GLEIFRefusal.StreetNameGenericOnly })
	})

	it("reads an AddressNumber of 0 as no number", () => {
		const zero = record({
			name: "MARWELL LIMITED",
			legal: {
				FirstAddressLine: "ELIZABETH AVENUE AND SHIRLEY STREET",
				AddressNumber: "0",
				City: "PORT LOUIS",
				Country: "MU",
			},
		})

		expect(readGLEIFAddress(zero, GLEIFAddressBlock.Legal)).toEqual({
			refused: GLEIFRefusal.StreetLineWithoutNumber,
		})
	})

	it("refuses every row of a country whose labeling has not been reviewed", () => {
		const dubai = record({
			name: "NASPER CAPITAL MANAGEMENT LIMITED",
			legal: { FirstAddressLine: "12 SHEIKH ZAYED ROAD", City: "DUBAI", Country: "AE" },
		})

		expect(readGLEIFAddress(dubai, GLEIFAddressBlock.Legal)).toEqual({ refused: GLEIFRefusal.CountryUnreviewed })
	})

	it("refuses a split that disagrees with the publisher's own AddressNumber", () => {
		const disagree = record({
			name: "TALLERES SA",
			legal: {
				FirstAddressLine: "Pol.Ind.Mugitegui Vial D 48",
				AddressNumber: "Vial D",
				City: "Urretxu",
				Country: "ES",
				PostalCode: "20700",
			},
		})

		expect(readGLEIFAddress(disagree, GLEIFAddressBlock.Legal)).toEqual({
			refused: GLEIFRefusal.StreetNumberDisagrees,
		})
	})

	it("reads a whole post-office-box line as po_box", () => {
		const box = record({
			name: "CAYMAN FUND LTD",
			legal: { FirstAddressLine: "PO BOX 309", City: "George Town", Country: "KY", PostalCode: "KY1-1104" },
		})

		const reading = readGLEIFAddress(box, GLEIFAddressBlock.Legal)

		if ("admitted" in reading) {
			expect(reading.admitted.components.po_box).toBe("PO BOX 309")
			expect(reading.admitted.components.street).toBeUndefined()
		} else {
			expect(reading.refused).toBe(GLEIFRefusal.CountryWithoutLayout)
		}
	})

	it("refuses a country codex has no layout for", () => {
		const ghana = record({
			name: "ACCRA LIMITED",
			legal: { FirstAddressLine: "25A Castle Road", City: "Accra", Country: "GH", PostalCode: "GA-233" },
		})

		expect(readGLEIFAddress(ghana, GLEIFAddressBlock.Legal)).toEqual({ refused: GLEIFRefusal.CountryWithoutLayout })
	})

	it("refuses a region code naming another country", () => {
		const contradicted = record({
			name: "ACME GMBH",
			legal: { FirstAddressLine: "Nadistraße 35", City: "München", Region: "AT-9", Country: "DE", PostalCode: "80809" },
		})

		expect(readGLEIFAddress(contradicted, GLEIFAddressBlock.Legal)).toEqual({
			refused: GLEIFRefusal.RegionContradictsCountry,
		})
	})
})

describe("normalizeGLEIFStreetLine", () => {
	it("removes a leading copy of the publisher's city", () => {
		expect(normalizeGLEIFStreetLine("WARSZAWA PUŁAWSKA 182", "Warszawa")).toBe("PUŁAWSKA 182")
	})

	it("removes a civic-number marker and the comma before it", () => {
		expect(normalizeGLEIFStreetLine("Piata Presei Libere, nr. 3-5", "Bucureşti, Sectorul 1")).toBe(
			"Piata Presei Libere 3-5"
		)

		expect(normalizeGLEIFStreetLine("Str Pacurari nr.128", "IASI")).toBe("Str Pacurari 128")
	})

	it("removes the period Hungary writes after a trailing number", () => {
		expect(normalizeGLEIFStreetLine("Bagoly utca 23.", "Szentendre")).toBe("Bagoly utca 23")
	})

	it("leaves a line that is the city itself", () => {
		expect(normalizeGLEIFStreetLine("Vaduz", "Vaduz")).toBe("Vaduz")
	})
})

describe("houseNumberLeadsStreet", () => {
	it("reads the order off the layout", () => {
		expect(houseNumberLeadsStreet("US")).toBe(true)
		expect(houseNumberLeadsStreet("DE")).toBe(false)
	})
})

describe("headquartersRepeatsLegal", () => {
	it("compares every address field", () => {
		expect(headquartersRepeatsLegal(SLADOVNA)).toBe(true)
		expect(headquartersRepeatsLegal(TWO_SIGMA)).toBe(false)
	})
})

/**
 * Quote every field, as the golden copy does.
 */
function toCSV(records: readonly GLEIFRecord[]): string {
	const columns = Object.keys(records[0]!)
	const quote = (value: string | undefined): string => `"${(value ?? "").replaceAll('"', '""')}"`

	return [columns.map(quote).join(","), ...records.map((entry) => columns.map((key) => quote(entry[key])).join(","))]
		.map((line) => `${line}\n`)
		.join("")
}

describe("gleif-lei adapter", () => {
	async function run(records: readonly GLEIFRecord[], options: { limit?: number; country?: string } = {}) {
		const inputPath = scratch.path("golden.csv")

		await writeLocalFile(toCSV(records), inputPath)

		return runAdapter({
			adapter: createGLEIFAdapter(),
			adapterOptions: { inputPath, ...options },
			outputDir: scratch.path,
			corpusVersion: "0.1.0",
		})
	}

	it("emits the legal and the distinct headquarters address, and counts the refusals", async () => {
		const soleProprietor = record({
			name: "MONIKA RADZIKOWSKA",
			category: "SOLE_PROPRIETOR",
			legal: { FirstAddressLine: "Kwiatowa 1", City: "Łódź", Country: "PL", PostalCode: "90-001" },
		})

		const manifest = await run([SLADOVNA, TWO_SIGMA, soleProprietor])

		expect(manifest.yielded).toBe(3)
		expect(manifest.dropped["record:sole-proprietor-category"]).toBe(1)
		expect(manifest.dropped["kept:headquarters-repeats-legal"]).toBe(1)

		const rows = await readCanonicalRows(scratch.path, GLEIF_ADAPTER_ID)

		expect(rows.map((row) => row.country).toSorted()).toEqual(["SK", "US", "US"])
		expect(rows.some((row) => row.components.venue === "MONIKA RADZIKOWSKA")).toBe(false)
	})

	it("emits one address once, keeping the first entity's venue", async () => {
		const sibling = record({
			name: "TWO SIGMA PRIVATE INVESTMENTS, LLC",
			legal: {
				FirstAddressLine: "2711 Centerville Road",
				City: "Wilmington",
				Region: "US-DE",
				Country: "US",
				PostalCode: "19808",
			},
		})

		const manifest = await run([TWO_SIGMA, sibling])

		expect(manifest.dropped["row:address-already-emitted"]).toBe(1)

		const rows = await readCanonicalRows(scratch.path, GLEIF_ADAPTER_ID)
		const wilmington = rows.filter((row) => row.components.locality === "Wilmington")

		expect(wilmington).toHaveLength(1)
		expect(wilmington[0]!.components.venue).toBe("TWO SIGMA INVESTMENTS, LP")
	})

	it("honors limit and country", async () => {
		expect((await run([SLADOVNA, TWO_SIGMA], { limit: 1 })).yielded).toBe(1)
		expect((await run([SLADOVNA, TWO_SIGMA], { country: "SK" })).yielded).toBe(1)
	})

	it("refuses a country codex holds no layout for", async () => {
		await expect(run([SLADOVNA], { country: "GH" })).rejects.toThrow(/gleif-lei/)
	})
})
