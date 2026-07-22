/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for the `locale` recipe's OA CITY-noise normalization (#241) and the country-append fraction (#728
 *   pattern, GB arc task 3). The `cleanCityNoise` classes come from the 2026-07-02 full-stream audit of the
 *   ES/IT/NL sources — see the {@link cleanCityNoise} docstring for the audit numbers. The invariant under test:
 *   drop pseudo-localities, strip glued admin-code suffixes, and DON'T touch the audit-verified real names a naive
 *   suffix rule would mangle. `applyCountryAppend` is tested in isolation (not through the full `localeRecipe.run`,
 *   which streams real multi-GB OA/PPD CSVs) so the byte-identical-when-unset invariant is provable without I/O.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { COUNTRY_SURFACE_FORMS } from "@mailwoman/codex/country"
import { afterAll, describe, expect, it } from "vitest"

import type { SynthesizedLocaleRow } from "../synthesize-german.ts"
import {
	applyCountryAppend,
	applyDistrictAsLocalityOverride,
	cleanCityNoise,
	type LocaleCountrySource,
	type LocalePart,
	readTuples,
	resolveLocaleParts,
} from "./locale.ts"
import { makeMulberry32 } from "./scaffold.ts"

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
	const dirs: string[] = []
	const tmp = (): string => {
		const d = mkdtempSync(join(tmpdir(), "mw-locale-"))
		dirs.push(d)

		return d
	}
	afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })))

	// A tiny OA slice exercising exactly what the CSVSpliterator migration touches: a CRLF terminator
	// (the real OA files are CRLF), a quoted field with an embedded comma, an empty REGION cell that
	// must fall back to part.region, and a header-driven column index. rng is unused below RESERVOIR_CAP.
	const OA_HEADER = "LON,LAT,NUMBER,STREET,UNIT,CITY,DISTRICT,REGION,POSTCODE,ID,HASH"

	it("parses quoted fields, CRLF terminators, and the region fallback", async () => {
		const file = join(tmp(), "part.csv")
		writeFileSync(
			file,
			[
				OA_HEADER,
				// Quoted street with an embedded comma; populated REGION.
				'22.6,49.3,12,"Main St, West",,Springfield,dist,Bayern,38-710,id1,hash1',
				// Empty REGION cell → must fall back to part.region.
				"22.7,49.2,5,Elm Ave,,Shelbyville,dist,,38-711,id2,hash2",
			].join("\r\n") + "\r\n"
		)

		const tuples = await readTuples({ path: file, region: "FallbackLand" }, () => 0)

		expect(tuples).toEqual([
			{ house_number: "12", street: "Main St, West", locality: "Springfield", region: "Bayern", postcode: "38-710" },
			{ house_number: "5", street: "Elm Ave", locality: "Shelbyville", region: "FallbackLand", postcode: "38-711" },
		])
	})

	it("districtAsLocality (NZ) maps DISTRICT→locality, CITY→dependent_locality; falls back when DISTRICT empty", async () => {
		const file = join(tmp(), "part.csv")
		writeFileSync(
			file,
			[
				OA_HEADER,
				// NZ shape: CITY = suburb (Birkenhead), DISTRICT = city (Auckland). NZ OA carries no postcode.
				"174.7,-36.8,31,Rawene Road,,Birkenhead,Auckland,,,id1,hash1",
				// Empty DISTRICT (~18% of NZ rows) → CITY becomes the locality, no dependent_locality.
				"174.4,-36.6,26A,Henley Road,,Kaukapakapa,,,,id2,hash2",
			].join("\n") + "\n"
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
		const file = join(tmp(), "gb.csv")
		writeFileSync(
			file,
			[
				"NUMBER,STREET,CITY,DISTRICT,REGION,POSTCODE",
				'14,"Beulah Hill",,"London","Greater London",SE19 3NF',
				'2,"High Street","Plaistow","Bromley","Greater London",BR1 4AA',
			].join("\n")
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
		const file = join(tmp(), "part.csv")
		writeFileSync(
			file,
			[
				OA_HEADER,
				// CITY and DISTRICT name the same place (differing only in case) — the ES CNIG `poblacion ==
				// municipio` majority case (the address point sits in the municipio's own main town, not a
				// pedanía). Must NOT surface as dependent_locality === locality.
				"1,2,10,Main St,,AMURRIO,Amurrio,Araba,01450,id,hash",
				// Genuinely distinct CITY/DISTRICT still produces dependent_locality (the districtAsLocality
				// contract is otherwise unchanged).
				"1,2,11,Elm Ave,,Baranbio,Amurrio,Araba,01450,id2,hash2",
			].join("\n") + "\n"
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
		const file = join(tmp(), "es-raw.csv")
		writeFileSync(
			file,
			[
				"X,Y,id_porpk,tipo,tipo_vial,nombre_via,numero,extension,id_pob,poblacion,cod_postal,ine_mun,municipio,provincia,comunidad_autonoma,fuente_datos,fecha_modificacion",
				// poblacion filled + distinct from municipio (real pedanía row, mirrors the verified Amurrio/Baranbio sample).
				'-2.922,43.0507,"1","PK",CARRETERA,A-2522,35,,"1600005667",Baranbio,01450,01002,Amurrio,Araba/Álava,País Vasco/Euskadi,src,2017/04/03',
				// poblacion empty → falls back to municipio→locality, no dependent_locality (the districtAsLocality
				// NZ-pattern fallback, exercised here through the CNIG column names instead of CITY/DISTRICT).
				'-2.503,42.836,"2","PK",CARRETERA,A-4136,15,,,,01240,01001,Alegría-Dulantzi,Araba/Álava,País Vasco/Euskadi,src,2017/04/03',
			].join("\n") + "\n"
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
		const file = join(tmp(), "part.csv")
		writeFileSync(
			file,
			[
				OA_HEADER,
				"1,2,10,,,NoStreetCity,d,R,00000,i,h", // no street → skip
				"1,2,11,SomeSt,,,d,R,00000,i,h", // no city → skip
				'1,2,12,RealSt,,"Comunidad de 09076, 09150 y 09578",d,R,00000,i,h', // quoted city-noise → drop
				"1,2,13,Keep St,,Keepville,d,R,00000,i,h", // kept
			].join("\n") + "\n"
		)

		const tuples = await readTuples({ path: file }, () => 0)

		expect(tuples).toEqual([
			{ house_number: "13", street: "Keep St", locality: "Keepville", region: "R", postcode: "00000" },
		])
	})
})

describe("applyCountryAppend (country-append fraction, #728 pattern)", () => {
	const makeRow = (): SynthesizedLocaleRow => ({
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
		// original part is untouched — the override never mutates the registered COUNTRY_SOURCES entry.
		expect(part.districtAsLocality).toBeUndefined()
	})

	it("false forces districtAsLocality off, overriding a part pinned true (GB/NZ debugging escape hatch)", () => {
		const part: LocalePart = { path: "/x.csv", districtAsLocality: true }

		expect(applyDistrictAsLocalityOverride(part, false)).toEqual({ path: "/x.csv", districtAsLocality: false })
	})
})

describe("resolveLocaleParts (ES pedanía part-list selection)", () => {
	const defaultParts: LocalePart[] = [{ path: "/conformed.csv" }]
	const pedaniaParts: LocalePart[] = [{ zip: "/raw.zip", csv: "raw.csv", cnigRaw: true, districtAsLocality: true }]
	const esLikeSource: LocaleCountrySource = {
		source: "synth-es",
		corpusVersion: "0.9.9",
		parts: defaultParts,
		pedaniaParts,
	}
	const noPedaniaSource: LocaleCountrySource = { source: "synth-de", corpusVersion: "0.4.0", parts: defaultParts }

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
