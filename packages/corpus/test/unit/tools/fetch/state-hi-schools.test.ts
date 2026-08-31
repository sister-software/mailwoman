/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"

import { pathExists, readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { fetchStateHISchools } from "@mailwoman/corpus/tools"
import { join } from "path-ts"
import { afterAll, beforeAll, expect, test } from "vitest"
import writeXlsxFile, { type SheetData } from "write-excel-file/node"

const HEADER = ["code", "name", "address", "city", "zip"]

let server: Server
let sourceURL: string

beforeAll(async () => {
	const data = (rows: Array<Array<string | number>>): SheetData => rows as SheetData

	const workbook = await writeXlsxFile([
		{
			sheet: "HIDOE",
			data: data([HEADER, [335, "Ahuimanu Elem School", "47-470 Hui Aeko Place", "Kaneohe", 96_744]]),
		},
		{
			sheet: "PCS",
			data: data([HEADER, [901, "Voyager Public Charter School", "2428 Wilder Avenue", "Honolulu", 96_822]]),
		},
	]).toBuffer()

	server = createServer((_req, res) => {
		res.writeHead(200, { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" })
		res.end(workbook)
	})

	await new Promise<void>((resolve) => {
		server.listen(0, "127.0.0.1", () => resolve())
	})

	sourceURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/SchoolList.xlsx`
})

afterAll(() => server.close())

test("fetchStateHISchools retains and validates the source workbook, then skips a matching artifact", async () => {
	await using scratch = await temporaryDirectory("mailwoman-state-hi-schools-")
	const reports: string[] = []
	const options = { outRoot: scratch.path, sourceURL }

	expect(await fetchStateHISchools(options, (line) => reports.push(line))).toEqual({
		fetched: 1,
		skipped: 0,
		failed: 0,
		failedCodes: [],
	})

	const sourceDir = join(scratch.path, "state-hi-schools")
	const workbookPath = join(sourceDir, "HI_Public_Schools_List.xlsx")
	const manifest = await readLocalJSONFile<Record<string, unknown>>(join(sourceDir, "MANIFEST.json"))

	expect(await pathExists(workbookPath)).toBe(true)
	expect(await pathExists(join(sourceDir, "HI_Public_Schools_List.csv"))).toBe(false)
	expect(manifest.filename).toBe("HI_Public_Schools_List.xlsx")
	expect(manifest.source_url).toBe(sourceURL)
	expect(reports.some((line) => line.includes("HIDOE + PCS validated"))).toBe(true)

	expect(await fetchStateHISchools(options)).toEqual({
		fetched: 0,
		skipped: 1,
		failed: 0,
		failedCodes: [],
	})
})
