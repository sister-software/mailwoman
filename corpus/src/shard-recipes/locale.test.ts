/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for the `locale` recipe's OA CITY-noise normalization (#241). The classes come from the
 *   2026-07-02 full-stream audit of the ES/IT/NL sources — see the {@link cleanCityNoise} docstring
 *   for the audit numbers. The invariant under test: drop pseudo-localities, strip glued admin-code
 *   suffixes, and DON'T touch the audit-verified real names a naive suffix rule would mangle.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, describe, expect, it } from "vitest"

import { cleanCityNoise, readTuples } from "./locale.ts"

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
