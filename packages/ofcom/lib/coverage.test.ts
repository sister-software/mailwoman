/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The fixtures under `test/fixtures/` copy rows verbatim from Ofcom's Connected Nations update Spring 2026
 *   fixed coverage data, January 2026 snapshot. The source is the fixed coverage and full-fiber take-up ZIP
 *   at version 2 of 2026-07-07, retrieved 2026-10-05 and published under OGL v3.0. Each fixture keeps its
 *   published file name and header.
 *
 *   The published files end lines with CRLF, and 119 of the 121 all-premises postcode files open with a
 *   UTF-8 byte-order mark. The fixtures use LF without the mark, and one test restores both.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { workspacePath } from "@mailwoman/core/paths"
import { TextSpliterator } from "spliterator"
import { describe, expect, test } from "vitest"

import {
	OfcomCoverageField,
	OfcomCoverageFieldError,
	OfcomCoverageLevel,
	OfcomPremisesSet,
	parseOfcomCoverage,
	parseOfcomCoverageFileName,
	readOfcomCoverageFile,
} from "#coverage"

const POSTCODE_ALL = "202601_fixed_pc_coverage_r2_CR.csv"
const POSTCODE_RESIDENTIAL = "202601_fixed_pc_coverage_res_r1_CR.csv"
const OUTPUT_AREA_ALL = "202601_fixed_oa_coverage_r1.csv"
const OUTPUT_AREA_RESIDENTIAL = "202601_fixed_oa_res_coverage_r1.csv"

function fixture(name: string) {
	return workspacePath("ofcom", "test", "fixtures", name)
}

/**
 * The fixture's lines.
 * Each fixture holds a header and at most three rows.
 */
function linesOf(text: string): string[] {
	return TextSpliterator.from(text).toArray()
}

/**
 * The fixture text with one cell replaced.
 * The fixtures quote no field, so a comma split is exact.
 */
function withCell(text: string, line: number, column: number, value: string): string {
	const lines = linesOf(text)
	const cells = lines[line - 1]!.split(",")

	cells[column] = value
	lines[line - 1] = cells.join(",")

	return lines.join("\n")
}

function columnOf(text: string, label: string): number {
	return linesOf(text)[0]!.split(",").indexOf(label)
}

describe("parseOfcomCoverageFileName", () => {
	test("reads the snapshot, level, premises set, revision and postcode area from each published name", () => {
		expect(parseOfcomCoverageFileName(POSTCODE_ALL)).toEqual({
			file: POSTCODE_ALL,
			snapshot: "2026-01",
			revision: 2,
			level: OfcomCoverageLevel.Postcode,
			premises: OfcomPremisesSet.All,
			postcodeArea: "CR",
		})

		expect(parseOfcomCoverageFileName(POSTCODE_RESIDENTIAL)).toMatchObject({
			revision: 1,
			level: OfcomCoverageLevel.Postcode,
			premises: OfcomPremisesSet.Residential,
			postcodeArea: "CR",
		})

		expect(parseOfcomCoverageFileName(OUTPUT_AREA_ALL)).toMatchObject({
			level: OfcomCoverageLevel.OutputArea,
			premises: OfcomPremisesSet.All,
			postcodeArea: null,
		})

		expect(parseOfcomCoverageFileName(OUTPUT_AREA_RESIDENTIAL)).toMatchObject({
			level: OfcomCoverageLevel.OutputArea,
			premises: OfcomPremisesSet.Residential,
		})
	})

	test("accepts the postcode spelling of Ofcom's guides", () => {
		expect(parseOfcomCoverageFileName("202601_fixed_postcode_coverage_r2_CW.csv")).toMatchObject({
			level: OfcomCoverageLevel.Postcode,
			revision: 2,
			postcodeArea: "CW",
		})

		expect(parseOfcomCoverageFileName("202507_fixed_postcode_res_coverage_r01_SE.csv")).toMatchObject({
			snapshot: "2025-07",
			revision: 1,
			premises: OfcomPremisesSet.Residential,
		})
	})

	test("refuses a name that states no snapshot or contradicts its level", () => {
		expect(() => parseOfcomCoverageFileName("coverage.csv")).toThrow(/not an Ofcom fixed-coverage file name/)

		expect(() => parseOfcomCoverageFileName("202601_fixed_pc_coverage_r2.csv")).toThrow(
			/without a postcode-area suffix/
		)

		expect(() => parseOfcomCoverageFileName("202601_fixed_oa_coverage_r1_CR.csv")).toThrow(
			/output-area file with a postcode-area suffix/
		)
	})
})

describe("readOfcomCoverageFile at postcode level", () => {
	test("returns the requested percentages for each postcode as area rows", async () => {
		const { source, rows } = await readOfcomCoverageFile(fixture(POSTCODE_ALL), [
			OfcomCoverageField.GigabitPercent,
			OfcomCoverageField.SuperfastPercent,
		])

		expect(source.snapshot).toBe("2026-01")
		expect([...rows.keys()]).toEqual(["CR0 5BX", "CR0 5BY", "CR0 5LP"])

		expect(rows.get("CR0 5BX")).toEqual({
			scope: "area",
			level: OfcomCoverageLevel.Postcode,
			area: "CR0 5BX",
			premises: OfcomPremisesSet.All,
			snapshot: "2026-01",
			file: POSTCODE_ALL,
			values: {
				[OfcomCoverageField.GigabitPercent]: 100,
				[OfcomCoverageField.SuperfastPercent]: 100,
			},
		})

		expect(rows.get("CR0 5LP")?.values[OfcomCoverageField.GigabitPercent]).toBe(0)
	})

	test("throws for a premises count, which Ofcom publishes from output-area level upward", async () => {
		await expect(readOfcomCoverageFile(fixture(POSTCODE_ALL), [OfcomCoverageField.AllPremises])).rejects.toThrow(
			OfcomCoverageFieldError
		)

		await expect(
			readOfcomCoverageFile(fixture(POSTCODE_ALL), [
				OfcomCoverageField.GigabitPercent,
				OfcomCoverageField.GigabitPremises,
			])
		).rejects.toThrow(/has no column for "Number of premises with Gigabit availability"/)
	})

	test("names every missing field and the level in the error", async () => {
		const error = await readOfcomCoverageFile(fixture(POSTCODE_ALL), [
			OfcomCoverageField.AllPremises,
			OfcomCoverageField.AllMatchedPremises,
		]).catch((caught: unknown) => caught)

		expect(error).toBeInstanceOf(OfcomCoverageFieldError)

		expect(error).toMatchObject({
			file: POSTCODE_ALL,
			level: OfcomCoverageLevel.Postcode,
			fields: [OfcomCoverageField.AllPremises, OfcomCoverageField.AllMatchedPremises],
		})
	})

	test("leaves a postcode the residential file omits absent rather than reading it as zero", async () => {
		const { source, rows } = await readOfcomCoverageFile(fixture(POSTCODE_RESIDENTIAL), [
			OfcomCoverageField.GigabitPercent,
		])

		expect(source.premises).toBe(OfcomPremisesSet.Residential)
		expect(rows.size).toBe(2)
		expect(rows.has("CR0 5LP")).toBe(false)
	})

	test("reads the published byte form, with CRLF line ends and a leading byte-order mark", async () => {
		const text = await readLocalTextFile(fixture(POSTCODE_ALL))
		const published = `﻿${text.replaceAll("\n", "\r\n")}`
		const { rows } = parseOfcomCoverage(published, POSTCODE_ALL, [OfcomCoverageField.GigabitPercent])

		expect([...rows.keys()]).toEqual(["CR0 5BX", "CR0 5BY", "CR0 5LP"])
		expect(rows.get("CR0 5BX")?.values[OfcomCoverageField.GigabitPercent]).toBe(100)
	})
})

describe("readOfcomCoverageFile at output-area level", () => {
	test("returns the premises denominator beside the requested counts", async () => {
		const { rows } = await readOfcomCoverageFile(fixture(OUTPUT_AREA_ALL), [
			OfcomCoverageField.AllPremises,
			OfcomCoverageField.AllMatchedPremises,
			OfcomCoverageField.GigabitPremises,
			OfcomCoverageField.GigabitPercent,
		])

		const row = rows.get("E00005233")

		expect(row?.level).toBe(OfcomCoverageLevel.OutputArea)

		expect(row?.values).toEqual({
			[OfcomCoverageField.AllPremises]: 509,
			[OfcomCoverageField.AllMatchedPremises]: 509,
			[OfcomCoverageField.GigabitPremises]: 371,
			[OfcomCoverageField.GigabitPercent]: 72.9,
		})

		expect([...rows.keys()]).toEqual(["E00005233", "E00174805", "E00178816"])
	})

	test("reads the residential file as its own premises set", async () => {
		const { source, rows } = await readOfcomCoverageFile(fixture(OUTPUT_AREA_RESIDENTIAL), [
			OfcomCoverageField.AllPremises,
			OfcomCoverageField.GigabitPremises,
		])

		expect(source.premises).toBe(OfcomPremisesSet.Residential)

		expect(rows.get("E00005233")?.values).toEqual({
			[OfcomCoverageField.AllPremises]: 447,
			[OfcomCoverageField.GigabitPremises]: 363,
		})
	})
})

describe("parseOfcomCoverage refusals", () => {
	test("an empty requested cell throws instead of reading as zero", async () => {
		const text = await readLocalTextFile(fixture(POSTCODE_ALL))
		const broken = withCell(text, 3, columnOf(text, OfcomCoverageField.GigabitPercent), "")

		expect(() => parseOfcomCoverage(broken, POSTCODE_ALL, [OfcomCoverageField.GigabitPercent])).toThrow(
			/line 3, area CR0 5BY: "Gigabit availability \(% premises\)" holds "", not a number/
		)
	})

	test("a non-numeric requested cell throws", async () => {
		const text = await readLocalTextFile(fixture(POSTCODE_ALL))
		const broken = withCell(text, 2, columnOf(text, OfcomCoverageField.SuperfastPercent), "n/a")

		expect(() => parseOfcomCoverage(broken, POSTCODE_ALL, [OfcomCoverageField.SuperfastPercent])).toThrow(
			/holds "n\/a", not a number/
		)
	})

	test("an unrequested column is not read", async () => {
		const text = await readLocalTextFile(fixture(POSTCODE_ALL))
		const altered = withCell(text, 2, columnOf(text, OfcomCoverageField.SuperfastPercent), "n/a")
		const { rows } = parseOfcomCoverage(altered, POSTCODE_ALL, [OfcomCoverageField.GigabitPercent])

		expect(rows.get("CR0 5BX")?.values).toEqual({ [OfcomCoverageField.GigabitPercent]: 100 })
	})

	test("a repeated area throws", async () => {
		const lines = linesOf(await readLocalTextFile(fixture(POSTCODE_ALL)))
		const repeated = [...lines.slice(0, 3), lines[1]!, ...lines.slice(3)].join("\n")

		expect(() => parseOfcomCoverage(repeated, POSTCODE_ALL, [OfcomCoverageField.GigabitPercent])).toThrow(
			/line 4 repeats the area CR0 5BX/
		)
	})

	test("a row narrower than the header throws", async () => {
		const lines = linesOf(await readLocalTextFile(fixture(POSTCODE_ALL)))

		lines[1] = lines[1]!.split(",").slice(0, -1).join(",")

		expect(() => parseOfcomCoverage(lines.join("\n"), POSTCODE_ALL, [OfcomCoverageField.GigabitPercent])).toThrow(
			/line 2 has 19 columns where the header has 20/
		)
	})

	test("an unclosed quote that joins lines throws rather than reading short", async () => {
		const text = await readLocalTextFile(fixture(POSTCODE_ALL))
		const broken = withCell(text, 3, columnOf(text, "postcode area"), '"CR')

		expect(() => parseOfcomCoverage(broken, POSTCODE_ALL, [OfcomCoverageField.GigabitPercent])).toThrow(
			/read 2 records from 3 data lines/
		)
	})

	test("a header without the level's key column throws", async () => {
		const text = await readLocalTextFile(fixture(OUTPUT_AREA_ALL))

		expect(() => parseOfcomCoverage(text, POSTCODE_ALL, [OfcomCoverageField.GigabitPercent])).toThrow(
			/names a postcode file, and its header has no "postcode_space" column/
		)
	})

	test("a postcode whose compact form or area disagrees with the file throws", async () => {
		const text = await readLocalTextFile(fixture(POSTCODE_ALL))

		expect(() =>
			parseOfcomCoverage(withCell(text, 2, 0, "CR05BZ"), POSTCODE_ALL, [OfcomCoverageField.GigabitPercent])
		).toThrow(/"postcode" CR05BZ disagrees with CR0 5BX/)

		expect(() =>
			parseOfcomCoverage(withCell(text, 2, columnOf(text, "postcode area"), "SE"), POSTCODE_ALL, [
				OfcomCoverageField.GigabitPercent,
			])
		).toThrow(/postcode area SE differs from the file's CR/)
	})
})
