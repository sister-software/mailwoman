/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { workspacePath } from "@mailwoman/core/paths"
import { describe, expect, it } from "vitest"

import { isCountryCodeAlpha2, parseCountryCodeAlpha2 } from "#iso3166/alpha2"
import { isCountryCodeAlpha3, parseCountryCodeAlpha3 } from "#iso3166/alpha3"
import {
	countryRecordCount,
	countryRecordsHeader,
	getCountryByAlpha2,
	getCountryByAlpha3,
	getCountryByNumeric,
} from "#iso3166/records"
import { alpha2ForAlpha3, alpha2ForNumeric, alpha3ForAlpha2 } from "#iso3166/relations"

interface Countries {
	records: Array<{ alpha2: string; alpha3: string; numeric: string; name: string; status: string; entityID: string }>
}

const normalized = await readLocalJSONFile<Countries>(workspacePath("registry", "data", "normalized", "iso3166-1.json"))

describe("ISO 3166-1 records", () => {
	it("read back every normalized record by each of its codes", () => {
		expect(countryRecordCount()).toBe(normalized.records.length)

		for (const record of normalized.records) {
			if (record.status !== "officially-assigned") continue

			expect(getCountryByAlpha2(record.alpha2)).toMatchObject(record)
			expect(getCountryByAlpha3(record.alpha3)).toMatchObject(record)
			expect(getCountryByNumeric(record.numeric)).toMatchObject(record)
		}
	})

	it("returns one shared frozen object per row", () => {
		const first = getCountryByAlpha3("AUS")

		expect(first).toBe(getCountryByAlpha2("AU"))
		expect(Object.isFrozen(first)).toBe(true)
	})

	it("keeps a former code readable with its status and out of the strict brand", () => {
		const former = normalized.records.find((record) => record.status === "formerly-used")!

		expect(getCountryByAlpha3(former.alpha3)?.status).toBe("formerly-used")
		expect(isCountryCodeAlpha3(former.alpha3)).toBe(false)
		expect(parseCountryCodeAlpha3(former.alpha3)).toEqual({
			ok: false,
			reason: "not-found-in-snapshot",
			input: former.alpha3,
		})
	})

	it("relates the three codes of one entity", () => {
		expect(alpha3ForAlpha2("AU")).toBe("AUS")
		expect(alpha2ForAlpha3("AUS")).toBe("AU")
		expect(alpha2ForNumeric("036")).toBe("AU")
		expect(alpha2ForAlpha3("XXX")).toBeNull()
	})

	it("distinguishes shape, case and absence in a strict parse", () => {
		expect(parseCountryCodeAlpha2("GB")).toEqual({ ok: true, value: "GB" })
		expect(parseCountryCodeAlpha2("gb")).toMatchObject({ ok: false, reason: "case" })
		expect(parseCountryCodeAlpha2(" GB")).toMatchObject({ ok: false, reason: "shape" })
		expect(parseCountryCodeAlpha2("GBR")).toMatchObject({ ok: false, reason: "shape" })
		expect(parseCountryCodeAlpha2("XX")).toMatchObject({ ok: false, reason: "not-found-in-snapshot" })
		expect(isCountryCodeAlpha2("US")).toBe(true)
		expect(isCountryCodeAlpha3("aus")).toBe(false)
	})

	it("declares its profile and sources in the header", () => {
		const header = countryRecordsHeader()

		expect(header.profile).toBe("open-2026-11")
		expect(header.sources.map((source) => source.id)).toEqual(["wikidata-iso3166-1"])
		expect(header.coverage).toMatchObject({ "officially-assigned": 249 })
	})
})
