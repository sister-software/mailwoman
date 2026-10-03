/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalFile, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import ADMZip from "adm-zip"
import { beforeAll, describe, expect, it } from "vitest"

import {
	cordisCountryCode,
	CORDISRefusal,
	createCORDISAdapter,
	CORDIS_ADAPTER_ID,
	CORDIS_LICENSE,
	loadPersonNameLexicon,
	naturalPersonForm,
	type PersonNameLexicon,
	readCORDISRecord,
	splitCORDISStreetLine,
	StreetOrder,
	streetOrderForCountry,
} from "#adapters/cordis/adapter"
import { SourceRegister } from "#registers"
import { runAdapter } from "#runner"
import { readCanonicalRows, useScratchDir } from "#test-kit"

const scratch = useScratchDir("cordis")

const HEADER =
	'"projectID";"projectAcronym";"organisationID";"vatNumber";"name";"shortName";"SME";"activityType";"street";"postCode";"city";"country";"nutsCode";"geolocation";"organizationURL";"contactForm";"contentUpdateDate";"rcn";"order";"role";"ecContribution";"netEcContribution";"totalCost";"endOfParticipation";"active"'

/**
 * Participation rows from the publisher's `organization.csv` members, verbatim.
 *
 * Read on 2026-10-03 from `cordis-h2020projects-csv.zip` (sha256 `d4a8e364…`),
 * except `HE_ICCS` and `HE_CORDOVA` from `cordis-HORIZONprojects-csv.zip` (`1496a16e…`)
 * and `FP7_ICCS` from `cordis-fp7projects-csv.zip` (`886ee479…`).
 * `HE_ICCS` and `FP7_ICCS` are one organization at one address in two programmes.
 */
const H2020_WELLCOME =
	'"632927";"ERC-EuropePMC-1-2014";"999905974";"GB744495211";"THE WELLCOME TRUST LIMITED";"";"false";"PRC";"EUSTON ROAD 215 GIBBS BUILDING";"NW1 2BE";"London";"UK";"UKI31";"51.525895694,-0.13394298";"http://www.wellcome.ac.uk";"https://ec.europa.eu/info/funding-tenders/opportunities/portal/screen/contact-form/project/999905974/632927";"2018-07-19 09:17:05";"2114706";"1";"coordinator";"230000";"230000";"230000";"false";""'

const H2020_LICR =
	'"633002";"ERCSC-VPRES-SUP2014";"998221957";"CHE105833232MWST";"LUDWIG INSTITUT FUR KREBSFORSCHUNG AG";"LICR";"false";"REC";"STADELHOFERSTRASSE 22";"8001";"Zurich";"CH";"CH040";"47.3671387,8.5475228";"http://www.licr.org";"https://ec.europa.eu/info/funding-tenders/opportunities/portal/screen/contact-form/project/998221957/633002";"2018-07-19 09:17:05";"2124376";"1";"coordinator";"258500";"258500";"258500";"false";""'

const H2020_UOA =
	'"633053";"EUROfusion";"999643007";"EL090145420";"ETHNIKO KAI KAPODISTRIAKO PANEPISTIMIO ATHINON";"UOA";"false";"HES";"6 CHRISTOU LADA STR";"105 61";"ATHINA";"EL";"EL303";"37.97850802,23.732519058";"http://www.elke.uoa.gr";"https://ec.europa.eu/info/funding-tenders/opportunities/portal/screen/contact-form/project/999643007/633053";"2017-09-11 10:25:16";"1906280";"14";"thirdParty";"0";"528340.97";"960619,95";"false";""'

const H2020_MNDA =
	'"633413";"MIROCALS";"937808902";"";"MOTOR NEURONE DISEASE ASSOCIATION";"Motor Neurone Disease Association";"false";"OTH";"10 15 NOTRE DAME MEWS";"NN1 2BG";"Northampton";"UK";"UKF24";"52.2385239,-0.9024929";"";"https://ec.europa.eu/info/funding-tenders/opportunities/portal/screen/contact-form/project/937808902/633413";"2023-12-07 16:55:20";"2391735";"11";"participant";"0";"0";"51611,25";"false";""'

const H2020_PIA =
	'"641607";"BEYOND";"941324376";"XK330079956";"AEROPORTI NDERKOMBETAR I PRISHTINES KONTROLLI AJROR ADEM JASHARI SHA";"PIA-Air Contro Adem Jashari";"false";"OTH";"VRELLE LYPJAN ANP KONTROLLI AJROR ADEM JASHARI";"10070";"PRISTINA";"XK";"XK";"42.6366318,21.0919412";"";"https://ec.europa.eu/info/funding-tenders/opportunities/portal/screen/contact-form/project/941324376/641607";"2023-03-10 21:03:33";"2409613";"11";"participant";"43250";"43250";"43250";"false";""'

const H2020_FARA =
	'"652671";"PROIntensAfrica";"998296065";"";"FORUM FOR AGRICULTURAL RESEARCH IN AFRICA, GHANA";"FARA";"false";"OTH";"12 ANMEDA STREET, ROMAN RIDGE";"PMB CT173";"Accra";"GH";"GH";"5.55602,-0.1969";"http://www.fara-africa.org";"https://ec.europa.eu/info/funding-tenders/opportunities/portal/screen/contact-form/project/998296065/652671";"2022-08-08 14:11:18";"2130273";"2";"participant";"109619";"109619";"179838,75";"false";""'

const H2020_HKU =
	'"690850";"RUBICON";"997352934";"";"THE UNIVERSITY OF HONG KONG";"UHK";"false";"HES";"Pokfulam Road";"";"Pokfulam";"HK";"HK";"22.2605244,114.1361846";"https://www.hku.hk";"https://ec.europa.eu/info/funding-tenders/opportunities/portal/screen/contact-form/project/997352934/690850";"2022-08-16 00:44:17";"1907437";"9";"partner";"";"0";"81000";"false";""'

const H2020_COMET =
	'"792210";"GeoFit";"928228018";"ESB66340514";"COMET GLOBAL INNOVATION, SL";"COMET";"true";"PRC";"C GRAN DE GRACIA NUM 1, PLANTA 4, PUERTA 3";"08012";"Barcelona";"ES";"ES511";"41.38879,2.15899";"";"https://ec.europa.eu/info/funding-tenders/opportunities/portal/screen/contact-form/project/928228018/792210";"2023-07-23 18:32:55";"1947059";"20";"participant";"284812.5";"284812.5";"406875";"false";""'

const HE_ICCS =
	'"101060884";"DIVINE";"999654356";"EL090162593";"EREVNITIKO PANEPISTIMIAKO INSTITOUTO SYSTIMATON EPIKOINONION KAI YPOLOGISTON";"RESEARCH UNIVERSITY INSTITUTE OF COMMUNICATION AND COMPUTER SYSTEMS";"false";"REC";"PATISION 42";"106 82";"ATHINA";"EL";"EL303";"37.988257282,23.730574512";"http://www.iccs.gr";"https://ec.europa.eu/info/funding-tenders/opportunities/portal/screen/contact-form/project/999654356/101060884";"2026-06-03 12:20:56";"1917133";"1";"coordinator";"520625";"520625";"520625";"false";""'

const HE_CORDOVA =
	'"101298715";"ELFA";"868955877";"";"CORDOVA Trey Christian";"";"";"PRC";"";"";"";"ES";"";"39.3260685,-4.8379791";"";"https://ec.europa.eu/info/funding-tenders/opportunities/portal/screen/contact-form/project/868955877/101298715";"2026-07-27 16:24:03";"1996606";"8";"participant";"214236.79";"214236.79";"214236,79";"false";""'

const FP7_ICCS =
	'"314056";"ARUM";"999654356";"EL090162593";"EREVNITIKO PANEPISTIMIAKO INSTITOUTO SYSTIMATON EPIKOINONION KAI YPOLOGISTON";"RESEARCH UNIVERSITY INSTITUTE OF COMMUNICATION AND COMPUTER SYSTEMS";"";"REC";"PATISION 42";"106 82";"ATHINA";"EL";"EL303";"39.591621450000005,21.2955477";"http://www.iccs.gr";"https://ec.europa.eu/info/funding-tenders/opportunities/portal/screen/contact-form/project/999654356/314056";"2019-08-02 12:10:29";"1917133";"9";"participant";"541640";"";"";"false";""'

const H2020_ROWS = [
	H2020_WELLCOME,
	H2020_LICR,
	H2020_UOA,
	H2020_MNDA,
	H2020_PIA,
	H2020_FARA,
	H2020_HKU,
	H2020_COMET,
	HE_ICCS,
	HE_CORDOVA,
	FP7_ICCS,
]

/**
 * A CSV holding `rows` under the publisher's header, as `organization.csv` writes it.
 */
function organizationCSV(rows: readonly string[]): string {
	return `${[HEADER, ...rows].join("\n")}\n`
}

function zipOf(content: string): Buffer {
	const zip = new ADMZip()

	zip.addFile("organization.csv", Buffer.from(content))
	zip.addFile("project.csv", Buffer.from('"id"\n"1"\n'))

	return zip.toBuffer()
}

let lexicon: PersonNameLexicon

beforeAll(async () => {
	lexicon = await loadPersonNameLexicon()
})

async function runOverCSV(options: { country?: string; limit?: number } = {}) {
	await using input = await temporaryDirectory("mailwoman-cordis-csv-")

	const path = input.path("organization.csv")

	await writeLocalTextFile(organizationCSV(H2020_ROWS), path)

	const dropped = new Map<string, number>()

	const manifest = await runAdapter({
		adapter: createCORDISAdapter(),
		adapterOptions: { inputPath: path, dropped, ...options },
		outputDir: scratch.path,
		corpusVersion: "0.1.0",
	})

	return { manifest, dropped, rows: await readCanonicalRows(scratch.path, CORDIS_ADAPTER_ID) }
}

describe("cordis adapter over published participation rows", () => {
	it("writes the three organizations whose address it can place, under the license and register", async () => {
		const { manifest, rows } = await runOverCSV()

		expect(manifest.yielded).toBe(3)

		expect(rows.map((row) => row.raw).toSorted()).toEqual([
			"EREVNITIKO PANEPISTIMIAKO INSTITOUTO SYSTIMATON EPIKOINONION KAI YPOLOGISTON, PATISION 42, 106 82 ATHINA",
			// Switzerland's layout prints the `CH-` prefix itself.
			"LUDWIG INSTITUT FUR KREBSFORSCHUNG AG, STADELHOFERSTRASSE 22, CH-8001 Zurich",
			"THE UNIVERSITY OF HONG KONG, Pokfulam Road, Pokfulam",
		])

		expect(rows.every((row) => row.license === CORDIS_LICENSE)).toBe(true)
		expect(rows.every((row) => row.register === SourceRegister.CORDISParticipants)).toBe(true)
		expect(rows.every((row) => row.source === CORDIS_ADAPTER_ID)).toBe(true)
	})

	it("maps EL to GR and splits the number on the side Greece writes it", async () => {
		const { rows } = await runOverCSV()
		const iccs = rows.find((row) => row.components.street === "PATISION")

		expect(iccs?.country).toBe("GR")
		expect(iccs?.components.house_number).toBe("42")
		expect(iccs?.components.postcode).toBe("106 82")
	})

	it("counts each refusal by reason, and the second participation of one address as a duplicate", async () => {
		const { dropped } = await runOverCSV()

		expect(Object.fromEntries(dropped)).toEqual({
			"row:duplicate-record": 1,
			[`row:${CORDISRefusal.StreetNumberUnplaced}`]: 2,
			[`row:${CORDISRefusal.StreetDigitInRemainder}`]: 2,
			[`row:${CORDISRefusal.CountryNotISO}`]: 1,
			[`row:${CORDISRefusal.CountryNoLayout}`]: 1,
			[`row:${CORDISRefusal.LocalityAbsent}`]: 1,
		})
	})

	it("honors country and limit", async () => {
		expect((await runOverCSV({ country: "GR" })).rows.map((row) => row.country)).toEqual(["GR"])
		expect((await runOverCSV({ limit: 1 })).manifest.yielded).toBe(1)
	})

	it("reads organization.csv out of every archive in a directory and writes an address once", async () => {
		await using input = await temporaryDirectory("mailwoman-cordis-zips-")

		await writeLocalFile(zipOf(organizationCSV([HE_ICCS])), input.path("cordis-HORIZONprojects-csv.zip"))
		await writeLocalFile(zipOf(organizationCSV([FP7_ICCS, H2020_LICR])), input.path("cordis-fp7projects-csv.zip"))

		const rows = await Array.fromAsync(createCORDISAdapter().rows({ inputPath: input.path }))

		expect(rows.map((row) => row.country).toSorted()).toEqual(["CH", "GR"])
	})

	it("raises on a directory holding no archive, rather than reading as a publisher with none", async () => {
		await using input = await temporaryDirectory("mailwoman-cordis-empty-")

		await expect(Array.fromAsync(createCORDISAdapter().rows({ inputPath: input.path }))).rejects.toThrow(
			/holds no \.zip archive/u
		)
	})

	it("raises on a file missing a column it indexes", async () => {
		await using input = await temporaryDirectory("mailwoman-cordis-columns-")

		const path = input.path("organization.csv")

		await writeLocalTextFile('"name";"city"\n"ACME";"Paris"\n', path)

		await expect(Array.fromAsync(createCORDISAdapter().rows({ inputPath: path }))).rejects.toThrow(
			/has no column organisationID/u
		)
	})
})

describe("cordisCountryCode", () => {
	it("maps the two EU codes that differ from ISO", () => {
		expect(cordisCountryCode("EL")).toBe("GR")
		expect(cordisCountryCode("UK")).toBe("GB")
		expect(cordisCountryCode("DE")).toBe("DE")
	})

	it("refuses a value that is no ISO alpha-2 code", () => {
		expect(cordisCountryCode("XK")).toBeNull()
		expect(cordisCountryCode("DE;HU")).toBeNull()
		expect(cordisCountryCode("ZZ")).toBeNull()
		expect(cordisCountryCode("")).toBeNull()
	})
})

describe("streetOrderForCountry", () => {
	it("reads the side codex's sources agree on, and none where they disagree", () => {
		expect(streetOrderForCountry("GB")).toBe(StreetOrder.NumberFirst)
		expect(streetOrderForCountry("DE")).toBe(StreetOrder.NumberLast)
		// Hong Kong's Chinese order writes the number last and its English order first.
		expect(streetOrderForCountry("HK")).toBeNull()
	})
})

describe("splitCORDISStreetLine", () => {
	it("splits the number on the country's side", () => {
		expect(splitCORDISStreetLine("70 MARLBOROUGH AVENUE", StreetOrder.NumberFirst)).toEqual({
			house_number: "70",
			street: "MARLBOROUGH AVENUE",
		})

		expect(splitCORDISStreetLine("STADELHOFERSTRASSE 22", StreetOrder.NumberLast)).toEqual({
			house_number: "22",
			street: "STADELHOFERSTRASSE",
		})
	})

	it("refuses a line written in the other order", () => {
		expect(splitCORDISStreetLine("EUSTON ROAD 215 GIBBS BUILDING", StreetOrder.NumberFirst)).toEqual({
			refused: CORDISRefusal.StreetNumberUnplaced,
		})

		expect(splitCORDISStreetLine("6 CHRISTOU LADA STR", StreetOrder.NumberLast)).toEqual({
			refused: CORDISRefusal.StreetNumberUnplaced,
		})
	})

	it("refuses a remainder that still holds a digit, rather than labeling a door as the house number", () => {
		expect(splitCORDISStreetLine("C GRAN DE GRACIA NUM 1, PLANTA 4, PUERTA 3", StreetOrder.NumberLast)).toEqual({
			refused: CORDISRefusal.StreetDigitInRemainder,
		})
	})

	it("refuses a kilometer point", () => {
		expect(splitCORDISStreetLine("CTRA SANT LLORENC DE MORUNYS KM, 2", StreetOrder.NumberLast)).toEqual({
			refused: CORDISRefusal.StreetNumberUnplaced,
		})
	})

	it("drops a civic marker left before the number", () => {
		expect(splitCORDISStreetLine("HAUPTSTRASSE NR. 5", StreetOrder.NumberLast)).toEqual({
			house_number: "5",
			street: "HAUPTSTRASSE",
		})
	})

	it("keeps a line with no digit whole where the country has no unambiguous side", () => {
		expect(splitCORDISStreetLine("Pokfulam Road", null)).toEqual({ street: "Pokfulam Road" })
		expect(splitCORDISStreetLine("TAT CHEE AVENUE 83", null)).toEqual({ refused: CORDISRefusal.StreetNumberUnplaced })
	})
})

describe("naturalPersonForm", () => {
	it("refuses a name whose every word is a personal name", () => {
		expect(naturalPersonForm("SCHWARZ KAI-UWE WOLFGANG", "SCHWARZ", lexicon)).toBe(CORDISRefusal.NamePersonalWords)
		expect(naturalPersonForm("Kerstin Minnich", "LIFE SCIENCE WRITING", lexicon)).toBe(CORDISRefusal.NamePersonalWords)
	})

	it("refuses the participant register's SURNAME Given casing", () => {
		expect(naturalPersonForm("BUCKENHUSKES Herbert Johannes", "", lexicon)).toBe(CORDISRefusal.NamePersonalCasing)
	})

	it("refuses a sole-trader legal form in the name or short name", () => {
		expect(naturalPersonForm("Melina Bucher", "Melina Bucher e.Kfr.", lexicon)).toBe(CORDISRefusal.NameSoleTrader)
		expect(naturalPersonForm("ebl Naturkost e.K.", "ebl", lexicon)).toBe(CORDISRefusal.NameSoleTrader)
	})

	it("admits organization names", () => {
		expect(naturalPersonForm("CARGILL FRANCE", "CARGILL", lexicon)).toBeNull()
		expect(naturalPersonForm("THE WELLCOME TRUST LIMITED", "", lexicon)).toBeNull()
		expect(naturalPersonForm("IDEMIA Public Security France", "", lexicon)).toBeNull()

		expect(
			naturalPersonForm(
				"STATE INSTITUTION INSTITUTE OF APPLIED GEOPHYSICS NAMED AFTER ACADEMICIAN E. K. FIODOROV",
				"FIAG",
				lexicon
			)
		).toBeNull()
	})
})

describe("readCORDISRecord", () => {
	it("drops a postcode with no digit and keeps the row", () => {
		const reading = readCORDISRecord(
			{ name: "UNIVERSITY COLLEGE CORK", street: "WESTERN ROAD", postCode: "EIRE", city: "Cork", country: "IE" },
			lexicon
		)

		expect(reading).toEqual({
			admitted: expect.objectContaining({ raw: "UNIVERSITY COLLEGE CORK, WESTERN ROAD, Cork" }),
			discarded: ["component:postcode:no-digit"],
		})
	})

	it("refuses a record whose only postcode the country's layout does not print", () => {
		// Burkina Faso's layout has no postcode slot, so this record would print as a name and a city.
		const reading = readCORDISRecord(
			{ name: "MINISTERE DE LA SANTE", street: "", postCode: "7003", city: "Ouagadougou", country: "BF" },
			lexicon
		)

		expect(reading).toEqual({ refused: CORDISRefusal.ComponentsTooFew, country: "BF" })
	})

	it("refuses a record that places nothing beside its locality", () => {
		expect(
			readCORDISRecord({ name: "ACME", street: "-", postCode: "N/A", city: "Lyon", country: "FR" }, lexicon)
		).toEqual({
			refused: CORDISRefusal.ComponentsTooFew,
			country: "FR",
		})
	})
})
