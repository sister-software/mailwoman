/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import {
	componentsForOSMRow,
	createOSMAdapter,
	housenumberIsDesignator,
	isStreetName,
	OSM_ADAPTER_ID,
	OSM_LICENSE,
	sameName,
	splitCityValue,
} from "@mailwoman/corpus/adapters/osm/adapter"
import { runAdapter } from "@mailwoman/corpus/runner"
import { readCanonicalRows, useScratchDir } from "@mailwoman/corpus/test-kit"
import { SHARE_ALIKE_PATTERN } from "@mailwoman/corpus/utils/license"
import { join } from "path-ts"
import { describe, expect, it } from "vitest"

const scratch = useScratchDir("osm")

const loadRows = () => readCanonicalRows(scratch.path, OSM_ADAPTER_ID)

async function writeFixture(name: string, rows: Record<string, unknown>[]): Promise<string> {
	const p = join(scratch.path, name)
	await writeLocalTextFile(rows.map((r) => JSON.stringify(r)).join("\n") + "\n", p)

	return p
}

describe("housenumberIsDesignator", () => {
	it("keeps the designator shapes and refuses a mapper's line", () => {
		for (const ok of ["12", "188a", "14/E", "1/1146", "167-c", "B-77", "L58", "R 948", "A 90"]) {
			expect(housenumberIsDesignator(ok), ok).toBe(true)
		}

		for (const no of ["House 34, Road 4, Sector 9", "Plot #27", "-", "Near Askari Towers 2", "B-S-1", "Shehzad Town"]) {
			expect(housenumberIsDesignator(no), no).toBe(false)
		}
	})
})

describe("isStreetName", () => {
	it("refuses a comma-carrying line and a nine-word sentence", () => {
		expect(isStreetName("Đường Nguyễn Văn Cừ")).toBe(true)
		expect(isStreetName("North Nazimabad Block H")).toBe(true)
		expect(isStreetName("UN Compound, Diplomatic Enclave-II, Sector G-4, Islamabad")).toBe(false)
		expect(isStreetName("one two three four five six seven eight nine")).toBe(false)
		expect(isStreetName("Near Cozy Water Park")).toBe(false)
		expect(isStreetName("Nearing Lane")).toBe(true)
	})
})

describe("splitCityValue", () => {
	it("takes the tail as the locality and the head as the neighborhood", () => {
		expect(splitCityValue("Mirpur 10, Dhaka")).toEqual({ locality: "Dhaka", head: "Mirpur 10" })
		expect(splitCityValue("Dhaka")).toEqual({ locality: "Dhaka", head: null })
	})
})

describe("sameName", () => {
	it("folds case, diacritics and a leading admin generic", () => {
		expect(sameName("Bắc Ninh", "Bac Ninh")).toBe(true)
		expect(sameName("Hà Nội", "Thành phố Hà Nội")).toBe(true)
		expect(sameName("Đà Nẵng", "Da Nang")).toBe(true)
		expect(sameName("Hà Nội", "Hà Nam")).toBe(false)
	})
})

describe("componentsForOSMRow", () => {
	it("drops a province that repeats the city under a generic, a comma-joined ward, and a scheme that repeats the street", () => {
		const repeatedProvince = {
			street: "Hàng Giấy",
			number: "34",
			city: "Hà Nội",
			subdistrict: "Phường Hoàn Kiếm",
			province: "Thành phố Hà Nội",
		}

		const commaWard = {
			street: "Đường Thiên Nga 2",
			number: "82",
			city: "Hà Nội",
			subdistrict: "Phân khu Tinh Hoa, Khu đô thị Tây Nam Linh Đàm",
			suburb: "Khu đô thị Tây Nam Linh Đàm",
		}

		const schemeIsStreet = {
			street: "New Karachi Sector 5C3",
			number: "L 271",
			city: "Karachi",
			place: "New Karachi Sector 5C3",
		}

		expect(componentsForOSMRow(repeatedProvince)).toEqual({
			street: "Hàng Giấy",
			house_number: "34",
			locality: "Hà Nội",
			dependent_locality: "Phường Hoàn Kiếm",
		})

		expect(componentsForOSMRow(commaWard)).toEqual({
			street: "Đường Thiên Nga 2",
			house_number: "82",
			locality: "Hà Nội",
			dependent_locality: "Khu đô thị Tây Nam Linh Đàm",
		})

		expect(componentsForOSMRow(schemeIsStreet)).toEqual({
			street: "New Karachi Sector 5C3",
			house_number: "L 271",
			locality: "Karachi",
		})
	})

	it("keeps a row with a district and no city", () => {
		expect(
			componentsForOSMRow({ street: "Đường Nguyễn Văn Cừ", number: "359", district: "Thành phố Bắc Ninh" })
		).toEqual({
			street: "Đường Nguyễn Văn Cừ",
			house_number: "359",
			dependent_locality: "Thành phố Bắc Ninh",
		})
	})

	it("maps the Vietnamese ward and province, and drops a province that repeats the city", () => {
		expect(
			componentsForOSMRow({
				street: "Đường Nguyễn Khánh Toàn",
				number: "118",
				postcode: "10000",
				city: "Hà Nội",
				district: "Cau Giay",
				province: "Hà Nội",
				subdistrict: "Cầu Giấy",
			})
		).toEqual({
			street: "Đường Nguyễn Khánh Toàn",
			house_number: "118",
			postcode: "10000",
			locality: "Hà Nội",
			dependent_locality: "Cầu Giấy",
		})
	})

	it("maps the Pakistani scheme as the dependent locality and keeps a block-lettered plot", () => {
		expect(
			componentsForOSMRow({ street: "North Nazimabad Block H", number: "A 90", city: "Karachi", place: "Nazimabad 4" })
		).toEqual({
			street: "North Nazimabad Block H",
			house_number: "A 90",
			locality: "Karachi",
			dependent_locality: "Nazimabad 4",
		})
	})

	it("drops a free-text house number, an N/A suburb, and a row that is a street alone", () => {
		expect(
			componentsForOSMRow({
				street: "Sonargaon Janapath",
				number: "House 34, Road 4, Sector 9",
				postcode: "1230",
				city: "Uttara, Dhaka",
				suburb: "N/A",
			})
		).toEqual({
			street: "Sonargaon Janapath",
			postcode: "1230",
			locality: "Dhaka",
			dependent_locality: "Uttara",
		})

		const bare = { street: "Đường Điện Biên Phủ", number: "568" }
		const floorOnly = { street: "Đường Điện Biên Phủ", number: "Tầng 8" }
		const lineAsStreet = { street: "UN Compound, Diplomatic Enclave-II", number: "5", city: "Islamabad" }

		expect(componentsForOSMRow(bare)).toEqual({ street: "Đường Điện Biên Phủ", house_number: "568" })
		expect(componentsForOSMRow(floorOnly)).toBeNull()
		expect(componentsForOSMRow(lineAsStreet)).toBeNull()
	})
})

describe("osm adapter", () => {
	it("stamps every row ODbL-1.0, which the share-alike pattern matches", async () => {
		const input = await writeFixture("osm-bd.corpus.jsonl", [
			{ street: "Road 104", number: "24", city: "Dhaka", postcode: "1207" },
			{ street: "Road 6", number: "14/E", city: "Mirpur 10, Dhaka" },
			{ street: "Sonargaon Janapath", number: "House 34, Road 4, Sector 9", postcode: "1230", city: "Uttara, Dhaka" },
		])

		const manifest = await runAdapter({
			adapter: createOSMAdapter(),
			adapterOptions: { inputPath: input, country: "BD" },
			outputDir: scratch.path,
			corpusVersion: "0.1.0",
		})

		expect(manifest.yielded).toBe(3)

		const rows = await loadRows()

		expect(rows).toHaveLength(3)
		expect(rows.every((r) => r.country === "BD")).toBe(true)
		expect(rows.every((r) => r.license === OSM_LICENSE)).toBe(true)
		expect(SHARE_ALIKE_PATTERN.test(OSM_LICENSE)).toBe(true)

		const road104 = rows.find((r) => r.raw.includes("Road 104"))

		expect(road104?.raw).toBe("24 Road 104, Dhaka - 1207")

		expect(road104?.components).toMatchObject({
			house_number: "24",
			street: "Road 104",
			locality: "Dhaka",
			postcode: "1207",
		})

		const mirpur = rows.find((r) => r.raw.includes("Road 6"))

		expect(mirpur?.components).toMatchObject({
			house_number: "14/E",
			locality: "Dhaka",
			dependent_locality: "Mirpur 10",
		})
	})

	it("rejects an invocation without --country", async () => {
		const input = await writeFixture("osm-vn.corpus.jsonl", [
			{ street: "Đường Tôn Đản", number: "126", city: "Đà Nẵng" },
		])

		await expect(
			runAdapter({
				adapter: createOSMAdapter(),
				adapterOptions: { inputPath: input },
				outputDir: scratch.path,
				corpusVersion: "0.1.0",
			})
		).rejects.toThrow(/--country is required/u)
	})
})
