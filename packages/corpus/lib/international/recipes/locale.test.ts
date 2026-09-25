/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests the locale recipe's city cleanup, CSV reading, country appending and district overrides against small
 *   fixtures.
 */

import { COUNTRY_SURFACE_FORMS } from "@mailwoman/codex/country"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { removePathIfPresent, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { mulberry32 as makeMulberry32 } from "@mailwoman/core/utils"
import {
	applyCountryAppend,
	applyDistrictAsLocalityOverride,
	cleanCityNoise,
	type LocaleCountrySource,
	type LocalePart,
	readTuples,
	resolveLocaleParts,
} from "@mailwoman/corpus/international/recipes/locale"
import { SourceRegister } from "@mailwoman/corpus/registers"
import type { RenderedLocaleRow } from "@mailwoman/corpus/surfaces/locale"
import type { PathBuilder } from "path-ts"
import { afterAll, describe, expect, it } from "vitest"

const fixtures = new AsyncDisposableStack()

afterAll(() => fixtures.disposeAsync())

describe("cleanCityNoise", () => {
	it("drops ES cadastral pseudo-localities (comma / ≥4-digit run)", () => {
		expect(cleanCityNoise("Comunidad de 09076, 09150 y 09578")).toBeNull()
		expect(cleanCityNoise("Ledanía de 09162, 09290, 09412 y 09606")).toBeNull()
		expect(cleanCityNoise("Comunidad de Covarrubias, Quintanilla del Coco y Retuerta")).toBeNull()
	})

	it("strips the NL BAG parenthesized province code (the glued region-suffix class)", () => {
		expect(cleanCityNoise("Bergen (NH)")).toBe("Bergen")
		expect(cleanCityNoise("Rijswijk (GLD)")).toBe("Rijswijk")
		expect(cleanCityNoise("Hengelo (Gld)")).toBe("Hengelo")
	})

	it("keeps NL ordinal-prefixed real names (one digit is not a postcode run)", () => {
		expect(cleanCityNoise("2e Valthermond")).toBe("2e Valthermond")
		expect(cleanCityNoise("1e Exloërmond")).toBe("1e Exloërmond")
	})

	it("keeps ES/IT city-ends-with-province real toponyms", () => {
		expect(cleanCityNoise("Alhama de Almería")).toBe("Alhama de Almería")
		expect(cleanCityNoise("GENZANO DI ROMA")).toBe("GENZANO DI ROMA")
	})

	it("keeps ES bilingual slash co-names (the eval expects them verbatim)", () => {
		expect(cleanCityNoise("Laudio/Llodio")).toBe("Laudio/Llodio")

		expect(cleanCityNoise("Sant Vicent del Raspeig/San Vicente del Raspeig")).toBe(
			"Sant Vicent del Raspeig/San Vicente del Raspeig"
		)
	})

	it("does not strip a long parenthetical (only the 1–3-letter admin-code shape)", () => {
		expect(cleanCityNoise("Ciudad (Vieja)")).toBe("Ciudad (Vieja)")
	})

	it("returns null when stripping leaves nothing", () => {
		expect(cleanCityNoise("(NH)")).toBeNull()
	})
})

describe("readTuples (OA CSV parse)", () => {
	const dirs: PathBuilder[] = []

	const tmp = async (): Promise<PathBuilder> => {
		const d = fixtures.use(await temporaryDirectory("mw-locale-")).path
		dirs.push(d)

		return d
	}

	afterAll(() => Promise.all(dirs.map((d) => removePathIfPresent(d))))

	const OA_HEADER = "LON,LAT,NUMBER,STREET,UNIT,CITY,DISTRICT,REGION,POSTCODE,ID,HASH"

	it("parses quoted fields, CRLF terminators, and the region fallback", async () => {
		const file = (await tmp())("part.csv")

		await writeLocalTextFile(
			[
				OA_HEADER,
				'22.6,49.3,12,"Main St, West",,Springfield,dist,Bayern,38-710,id1,hash1',
				// This row has an empty region, so the part's region applies.
				"22.7,49.2,5,Elm Ave,,Shelbyville,dist,,38-711,id2,hash2",
			].join("\r\n") + "\r\n",
			file
		)

		const tuples = await readTuples({ path: file, region: "FallbackLand" }, () => 0)

		expect(tuples).toEqual([
			{ house_number: "12", street: "Main St, West", locality: "Springfield", region: "Bayern", postcode: "38-710" },
			{ house_number: "5", street: "Elm Ave", locality: "Shelbyville", region: "FallbackLand", postcode: "38-711" },
		])
	})

	it("districtAsLocality (NZ) maps DISTRICT→locality, CITY→dependent_locality; falls back when DISTRICT empty", async () => {
		const file = (await tmp())("part.csv")

		await writeLocalTextFile(
			[
				OA_HEADER,
				// NZ puts the suburb in CITY and the city in DISTRICT.
				"174.7,-36.8,31,Rawene Road,,Birkenhead,Auckland,,,id1,hash1",
				// This row has no district, so CITY becomes the locality.
				"174.4,-36.6,26A,Henley Road,,Kaukapakapa,,,,id2,hash2",
			],
			file
		)

		const tuples = await readTuples({ path: file, districtAsLocality: true }, () => 0)

		expect(tuples).toEqual([
			{
				house_number: "31",
				street: "Rawene Road",
				locality: "Auckland",
				dependent_locality: "Birkenhead",
				region: "",
				postcode: "",
			},
			{ house_number: "26A", street: "Henley Road", locality: "Kaukapakapa", region: "", postcode: "" },
		])
	})

	it("GB tuples: CITY→dependent_locality, DISTRICT→locality via districtAsLocality (empty CITY kept)", async () => {
		const file = (await tmp())("gb.csv")

		await writeLocalTextFile(
			[
				"NUMBER,STREET,CITY,DISTRICT,REGION,POSTCODE",
				'14,"Beulah Hill",,"London","Greater London",SE19 3NF',
				'2,"High Street","Plaistow","Bromley","Greater London",BR1 4AA',
			].join("\n"),
			file
		)

		const tuples = await readTuples({ path: file, districtAsLocality: true }, () => 0)

		expect(tuples).toEqual([
			{ house_number: "14", street: "Beulah Hill", locality: "London", region: "Greater London", postcode: "SE19 3NF" },
			{
				house_number: "2",
				street: "High Street",
				locality: "Bromley",
				region: "Greater London",
				postcode: "BR1 4AA",
				dependent_locality: "Plaistow",
			},
		])
	})

	it("districtAsLocality: drops dependent_locality when it equals locality (case-insensitive) instead of emitting a same-value pair", async () => {
		const file = (await tmp())("part.csv")

		await writeLocalTextFile(
			[
				OA_HEADER,
				"1,2,10,Main St,,AMURRIO,Amurrio,Araba,01450,id,hash",
				"1,2,11,Elm Ave,,Baranbio,Amurrio,Araba,01450,id2,hash2",
			],
			file
		)

		const tuples = await readTuples({ path: file, districtAsLocality: true }, () => 0)

		expect(tuples).toEqual([
			{ house_number: "10", street: "Main St", locality: "Amurrio", region: "Araba", postcode: "01450" },
			{
				house_number: "11",
				street: "Elm Ave",
				locality: "Amurrio",
				dependent_locality: "Baranbio",
				region: "Araba",
				postcode: "01450",
			},
		])
	})

	it("ES pedanía (cnigRaw): joins tipo_vial+nombre_via→street, poblacion→dependent_locality, municipio→locality", async () => {
		const file = (await tmp())("es-raw.csv")

		await writeLocalTextFile(
			[
				"X,Y,id_porpk,tipo,tipo_vial,nombre_via,numero,extension,id_pob,poblacion,cod_postal,ine_mun,municipio,provincia,comunidad_autonoma,fuente_datos,fecha_modificacion",
				'-2.922,43.0507,"1","PK",CARRETERA,A-2522,35,,"1600005667",Baranbio,01450,01002,Amurrio,Araba/Álava,País Vasco/Euskadi,src,2017/04/03',
				// This row has an empty `poblacion`, so it gets no dependent locality.
				'-2.503,42.836,"2","PK",CARRETERA,A-4136,15,,,,01240,01001,Alegría-Dulantzi,Araba/Álava,País Vasco/Euskadi,src,2017/04/03',
			],
			file
		)

		const tuples = await readTuples({ path: file, cnigRaw: true, districtAsLocality: true }, () => 0)

		expect(tuples).toEqual([
			{
				house_number: "35",
				street: "CARRETERA A-2522",
				locality: "Amurrio",
				dependent_locality: "Baranbio",
				region: "País Vasco/Euskadi",
				postcode: "01450",
			},
			{
				house_number: "15",
				street: "CARRETERA A-4136",
				locality: "Alegría-Dulantzi",
				region: "País Vasco/Euskadi",
				postcode: "01240",
			},
		])
	})

	it("skips rows missing street or city, and drops city-noise rows", async () => {
		const file = (await tmp())("part.csv")

		await writeLocalTextFile(
			[
				OA_HEADER,
				"1,2,10,,,NoStreetCity,d,R,00000,i,h",
				"1,2,11,SomeSt,,,d,R,00000,i,h",
				'1,2,12,RealSt,,"Comunidad de 09076, 09150 y 09578",d,R,00000,i,h',
				"1,2,13,Keep St,,Keepville,d,R,00000,i,h",
			],
			file
		)

		const tuples = await readTuples({ path: file }, () => 0)

		expect(tuples).toEqual([
			{ house_number: "13", street: "Keep St", locality: "Keepville", region: "R", postcode: "00000" },
		])
	})
})

describe("applyCountryAppend (country-append fraction, #728 pattern)", () => {
	const makeRow = (): RenderedLocaleRow => ({
		raw: "14 Beulah Hill, London SE19 3NF",
		components: { house_number: "14", street: "Beulah Hill", locality: "London", postcode: "SE19 3NF" },
		locale: "en-GB",
	})

	it("countryFraction 1: every row ends with a GB surface form and carries components.country", () => {
		const random = makeMulberry32(1)

		for (let i = 0; i < 2; i++) {
			const row = makeRow()

			applyCountryAppend(row, "GB", 1, random)

			expect(row.components.country).toBeDefined()
			expect(COUNTRY_SURFACE_FORMS.GB).toContain(row.components.country)
			expect(row.raw).toBe(`14 Beulah Hill, London SE19 3NF, ${row.components.country}`)
		}
	})

	it("countryFraction 0 (the default when the flag is absent): rows are untouched, RNG untouched — byte-identical", () => {
		let calls = 0

		const random = (): number => {
			calls++

			return 0
		}

		const row = makeRow()
		const before = { ...row, components: { ...row.components } }

		applyCountryAppend(row, "GB", 0, random)

		expect(row).toEqual(before)
		expect(calls).toBe(0)
	})

	it("countryFraction 1 + a country with no COUNTRY_SURFACE_FORMS entry: throws instead of silently no-opping (BR/NZ lesson)", () => {
		const random = makeMulberry32(1)
		const row = makeRow()

		expect(() => applyCountryAppend(row, "ZZ_FAKE", 1, random)).toThrow(
			"No COUNTRY_SURFACE_FORMS entry for ZZ_FAKE — add it to codex/country/country.ts before using --country-fraction"
		)
	})

	it("countryFraction 1: NZ now appends a real surface form", () => {
		const random = makeMulberry32(7)
		const row = makeRow()

		applyCountryAppend(row, "NZ", 1, random)

		expect(row.components.country).toBeDefined()
		expect(COUNTRY_SURFACE_FORMS.NZ).toContain(row.components.country)
		expect(row.raw).toBe(`14 Beulah Hill, London SE19 3NF, ${row.components.country}`)
	})
})

describe("applyDistrictAsLocalityOverride (--district-as-locality tri-state)", () => {
	it("undefined (flag absent) returns the SAME part object — no override, byte-identical to before the flag existed", () => {
		const part: LocalePart = { path: "/x.csv", districtAsLocality: true }

		expect(applyDistrictAsLocalityOverride(part, undefined)).toBe(part)
	})

	it("true forces districtAsLocality on, even overriding a part pinned false-ish (unset)", () => {
		const part: LocalePart = { path: "/x.csv" }

		expect(applyDistrictAsLocalityOverride(part, true)).toEqual({ path: "/x.csv", districtAsLocality: true })
		// The override returns a copy and leaves the registered part unchanged.
		expect(part.districtAsLocality).toBeUndefined()
	})

	it("false forces districtAsLocality off, overriding a part pinned true (GB/NZ debugging override)", () => {
		const part: LocalePart = { path: "/x.csv", districtAsLocality: true }

		expect(applyDistrictAsLocalityOverride(part, false)).toEqual({ path: "/x.csv", districtAsLocality: false })
	})
})

describe("resolveLocaleParts (ES pedanía part-list selection)", () => {
	const defaultParts: LocalePart[] = [{ path: "/conformed.csv" }]
	const pedaniaParts: LocalePart[] = [{ zip: "/raw.zip", csv: "raw.csv", cnigRaw: true, districtAsLocality: true }]

	const esLikeSource: LocaleCountrySource = {
		source: "synth-es",
		register: SourceRegister.OpenAddresses,
		corpusVersion: "0.9.9",
		parts: defaultParts,
		pedaniaParts,
	}

	const noPedaniaSource: LocaleCountrySource = {
		source: "synth-de",
		register: SourceRegister.OpenAddresses,
		corpusVersion: "0.4.0",
		parts: defaultParts,
	}

	it("override undefined (flag absent): default parts, regardless of whether pedaniaParts exists", () => {
		expect(resolveLocaleParts(esLikeSource, undefined)).toBe(defaultParts)
		expect(resolveLocaleParts(noPedaniaSource, undefined)).toBe(defaultParts)
	})

	it("override true + pedaniaParts registered: selects pedaniaParts (the synth-es-pedania build)", () => {
		expect(resolveLocaleParts(esLikeSource, true)).toBe(pedaniaParts)
	})

	it("override true + no pedaniaParts registered: falls back to default parts (GB/NZ — just forces the per-part flag)", () => {
		expect(resolveLocaleParts(noPedaniaSource, true)).toBe(defaultParts)
	})

	it("override false: always the default parts, even when pedaniaParts exists", () => {
		expect(resolveLocaleParts(esLikeSource, false)).toBe(defaultParts)
	})
})
