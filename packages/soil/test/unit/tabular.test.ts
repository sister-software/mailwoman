/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The pipe-delimited reader: the embedded-newline trap, the dictionary bootstrap, and the projection that
 *   throws rather than dropping a column.
 *
 *   THE EMBEDDED NEWLINE IS NOT HYPOTHETICAL. Measured on the real `IA153` export: `sacatlog.txt` holds 594
 *   newline bytes and exactly ONE record, because its `fgdcmetadata` column carries a 43,251-character XML
 *   document; `mstabcol.txt` — the column dictionary itself — holds 913 newlines and 865 records. The
 *   fixtures below reproduce that shape at a size a test can hold.
 */

import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { readDeclaredDomains, readTable, readTabularDictionary, saverestToISODate } from "@mailwoman/soil/sdk/tabular"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

let scratch: TemporaryDirectory

/**
 * `mstab.txt` is five columns: table, physical name, label, description, FILE BASE NAME. The file name is the last
 * column and is not derivable from the table name — `component` lives in `comp.txt`, `sacatalog` in `sacatlog.txt`.
 */
const MSTAB = [
	'"widget"|"widget_table"|"Widget"|"A widget."|"widgetfile"',
	'"gadget"|"gadget_table"|"Gadget"|"A gadget."|"gadget"',
].join("\r\n")

/**
 * `mstabcol.txt` is fourteen columns, and one of its descriptions carries an embedded newline — which is the whole
 * point of the fixture.
 */
const MSTABCOL = [
	'"widget"|1|"widget_key"|"widget_key"|"Key"|"String"|"Yes"|30||||||"The key."',
	'"widget"|2|"widget_name"|"widget_name"|"Name"|"String"|"No"|175||||||"A name whose description\r\nspans two lines, exactly as the real dictionary does."',
	'"widget"|3|"widget_note"|"widget_note"|"Note"|"String"|"No"|175||||||"A note."',
	'"gadget"|1|"gadget_key"|"gadget_key"|"Key"|"String"|"Yes"|30||||||"The key."',
].join("\r\n")

const WIDGETFILE = ['"w1"|"first"|"note one"', '"w2"|"second\r\nwith a newline"|"note two"'].join("\r\n")

const MSDOMDET = [
	'"capability_class"|1|"1"|"Soils in Class 1 have few limitations."|"No"',
	'"capability_class"|2|"2"|"Soils in Class 2 have some limitations."|"No"',
	'"capability_subclass"|1|"e"|"erosion"|"No"',
].join("\r\n")

beforeAll(async () => {
	scratch = await temporaryDirectory("mw-soil-tabular-")

	await writeLocalTextFile(`${MSTAB}\r\n`, scratch.resolve("mstab.txt"))
	await writeLocalTextFile(`${MSTABCOL}\r\n`, scratch.resolve("mstabcol.txt"))
	await writeLocalTextFile(`${WIDGETFILE}\r\n`, scratch.resolve("widgetfile.txt"))
	await writeLocalTextFile(`${MSDOMDET}\r\n`, scratch.resolve("msdomdet.txt"))
})

afterAll(() => scratch[Symbol.asyncDispose]())

describe("the tabular dictionary", () => {
	it("maps a logical table to the file that actually holds it", async () => {
		const dictionary = await readTabularDictionary(scratch.path)

		expect(dictionary.files.get("widget")).toBe("widgetfile")
		expect(dictionary.columns.get("widget")?.get("widget_name")).toBe(1)
	})

	it("reads a record whose column carries an embedded newline as ONE record", async () => {
		const dictionary = await readTabularDictionary(scratch.path)
		const table = await readTable(scratch.path, dictionary, "widget", ["widget_key", "widget_name"])

		// The file holds three newline bytes and two records. A line-splitting reader would report three.
		expect(table.recordCount).toBe(2)
		expect(table.rows).toHaveLength(2)
		expect(table.rows[1]!.widget_name).toContain("with a newline")
	})

	it("throws on a requested column the shipped dictionary does not declare", async () => {
		const dictionary = await readTabularDictionary(scratch.path)

		// The failure this refuses is the repo's worst measurement shape: a silently dropped column reads downstream as an
		// empty world rather than as an error.
		await expect(readTable(scratch.path, dictionary, "widget", ["widget_key", "renamed_column"])).rejects.toThrow(
			/declares no column/u
		)
	})

	it("throws on a table the archive's own file map does not name", async () => {
		const dictionary = await readTabularDictionary(scratch.path)

		await expect(readTable(scratch.path, dictionary, "nosuchtable", ["x"])).rejects.toThrow(
			/declares no file for table/u
		)
	})

	it("reads the authority's declared domains, definitions included", async () => {
		const domains = await readDeclaredDomains(scratch.path)

		expect(domains.filter((member) => member.domain === "capability_class")).toHaveLength(2)
		expect(domains.find((member) => member.code === "e")?.definition).toBe("erosion")
	})
})

describe("saverestToISODate", () => {
	it("reads both spellings of the same instant the two channels use", () => {
		// Soil Data Access answers `9/9/2025 1:57:25 PM`; the shipped sacatlog.txt writes `09/09/2025 13:57:25`.
		expect(saverestToISODate("9/9/2025 1:57:25 PM")).toBe("2025-09-09")
		expect(saverestToISODate("09/09/2025 13:57:25")).toBe("2025-09-09")
	})

	it("throws rather than guessing, because a wrong date asks the download host for a file it answers 400 for", () => {
		expect(() => saverestToISODate("2025-09-09")).toThrow(/cannot read/u)
	})
})
