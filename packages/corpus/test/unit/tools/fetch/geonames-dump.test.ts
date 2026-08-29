/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file `fetchGeonamesDumps` — catalog-driven coverage, the zip→txt extraction, and the two presence traps: a country
 *   the source does not publish (404 ≠ transfer failure, the geonames-postal lesson) and a present `<CC>.txt` that is
 *   not a gazetteer dump at all (GeoNames' postal exports share the basename; seven tier-1 postal files sat at these
 *   paths reading as coverage until the capitals build found them capital-less).
 */

import { parseJSONStrict } from "@mailwoman/core/objects"
import { fetchGeonamesDumps, looksLikeGazetteerDump, parseCountryInfo } from "@mailwoman/corpus/tools"
import { mkdtempSync, readFileSync, writeFileSync } from "@mailwoman/platform/fs"
import { createServer, type Server } from "@mailwoman/platform/http"
import type { AddressInfo } from "@mailwoman/platform/net"
import { tmpdir } from "@mailwoman/platform/os"
import { join } from "@mailwoman/platform/path"
import ADMZip from "adm-zip"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

let server: Server
let baseURL: string

/**
 * A 19-column gazetteer dump row for one place.
 */
function dumpRow(id: number, name: string, fcode: string, country: string): string {
	const cols = new Array<string>(19).fill("")

	cols[0] = String(id)
	cols[1] = name
	cols[2] = name
	cols[4] = "10.0"
	cols[5] = "20.0"
	cols[6] = "P"
	cols[7] = fcode
	cols[8] = country

	return cols.join("\t")
}

function zipOf(entryName: string, content: string): Buffer {
	const zip = new ADMZip()

	zip.addFile(entryName, Buffer.from(content))

	return zip.toBuffer()
}

/**
 * The catalog names three countries: AA (published), BB (published), XX (in the catalog, but the dump directory 404s).
 */
const COUNTRY_INFO = [
	"# comment line",
	"AA\tAAA\t004\tAF\tAaland\tAa City\t652230\t37172386\tAS\t.aa",
	"BB\tBBB\t008\tAL\tBebland\tBe City\t28748\t2866376\tEU\t.bb",
	"XX\tXXX\t012\tDZ\tExland\tEx City\t2381741\t42228429\tAF\t.xx",
].join("\n")

beforeAll(async () => {
	server = createServer((req, res) => {
		if (req.url === "/countryInfo.txt") {
			res.writeHead(200)
			res.end(COUNTRY_INFO)
		} else if (req.url === "/AA.zip") {
			res.writeHead(200)
			res.end(zipOf("AA.txt", dumpRow(1, "Aa City", "PPLC", "AA")))
		} else if (req.url === "/BB.zip") {
			res.writeHead(200)
			res.end(zipOf("BB.txt", dumpRow(2, "Be City", "PPLC", "BB")))
		} else if (req.url === "/XX.zip") {
			res.writeHead(404)
			res.end("not found")
		} else {
			res.writeHead(500)
			res.end("boom")
		}
	})

	await new Promise<void>((resolve) => {
		server.listen(0, "127.0.0.1", resolve)
	})

	baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(() => {
	server.close()
})

interface DumpManifest {
	files: Array<Record<string, unknown>>
	skipped_present: string[]
	unavailable: string[]
	wrong_format_present: string[]
	[key: string]: unknown
}

function readManifest(outRoot: string): DumpManifest {
	return parseJSONStrict(readFileSync(join(outRoot, "MANIFEST.json"), "utf8"))
}

describe("fetchGeonamesDumps", () => {
	it("derives the country set from countryInfo.txt, extracts each zip to <CC>.txt, and records the 404 country as unavailable", async () => {
		const outRoot = mkdtempSync(join(tmpdir(), "mw-geonames-dump-"))
		const summary = await fetchGeonamesDumps({ outRoot, baseURL })

		// The catalog is the denominator: three countries named, two published, one 404.
		expect(summary.fetched).toBe(2)
		expect(summary.failedCodes).toEqual(["XX"])

		// The zip is extracted and removed — the directory holds the txt, not the archive.
		const aa = readFileSync(join(outRoot, "AA.txt"), "utf8")

		expect(aa).toContain("Aa City")
		expect(looksLikeGazetteerDump(aa)).toBe(true)

		const manifest = readManifest(outRoot)

		expect(manifest.unavailable).toEqual(["XX"])
		expect(manifest.files).toHaveLength(2)
		expect(manifest.license).toBe("CC-BY-4.0")
	})

	it("skips a present gazetteer dump but reports a present WRONG-FORMAT file instead of counting it as coverage", async () => {
		const outRoot = mkdtempSync(join(tmpdir(), "mw-geonames-dump-"))

		// AA is already a real dump; BB is a 12-column postal export squatting on the dump filename.
		writeFileSync(join(outRoot, "AA.txt"), dumpRow(1, "Aa City", "PPLC", "AA"))

		writeFileSync(
			join(outRoot, "BB.txt"),
			["BB", "1000", "Be City", "", "", "", "", "", "", "1.0", "2.0", "6"].join("\t")
		)

		const summary = await fetchGeonamesDumps({ outRoot, baseURL, countries: ["AA", "BB"] })

		expect(summary.fetched).toBe(0)
		expect(summary.skippedPresent).toEqual(["AA"])

		const manifest = readManifest(outRoot)

		expect(manifest.skipped_present).toEqual(["AA"])
		expect(manifest.wrong_format_present).toEqual(["BB"])

		// The wrong-format file is reported, never clobbered — this tool does not overwrite data it did not fetch.
		expect(readFileSync(join(outRoot, "BB.txt"), "utf8")).toContain("Be City")
	})
})

describe("parseCountryInfo", () => {
	it("reads ISO codes and capital names, skipping commentary", () => {
		expect(parseCountryInfo(COUNTRY_INFO)).toEqual([
			{ country: "AA", capital: "Aa City" },
			{ country: "BB", capital: "Be City" },
			{ country: "XX", capital: "Ex City" },
		])
	})
})

describe("looksLikeGazetteerDump", () => {
	it("accepts a 19-column dump and rejects the 12-column postal format", () => {
		expect(looksLikeGazetteerDump(dumpRow(1, "X", "PPL", "AA"))).toBe(true)
		expect(looksLikeGazetteerDump("AA\t1000\tPlace\t\t\t\t\t\t\t1.0\t2.0\t6")).toBe(false)
		expect(looksLikeGazetteerDump("")).toBe(false)
	})
})
