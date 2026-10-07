/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { APIClient } from "@mailwoman/core/api"
import { type StubResult, stubTransport } from "@mailwoman/core/api/test-transport"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalFile } from "@mailwoman/core/fs/writers"
import { sha256File } from "@mailwoman/core/hash"
import { silentLogger } from "@mailwoman/core/logging"
import { describe, expect, it } from "vitest"

import { BD_ADRESSES_REQUIRED_COLUMNS } from "#lu/adapters/bd-adresses/adapter"
import {
	type BDAdressesManifest,
	downloadBDAdresses,
	LU_BD_ADRESSES_CSV_FILENAME,
	LU_BD_ADRESSES_DELIMITER,
	readBDAdressesResource,
} from "#lu/tools/fetch/bd-adresses"
import { writeManifest } from "#tools/fetch/download"
import { assertHeaderColumns, readDelimitedHeader } from "#tools/fetch/header"

/**
 * The dated download URL of the edition these tests describe.
 */
const EDITION_URL =
	"https://download.data.public.lu/resources/adresses-georeferencees-bd-adresses/20260928-023119/addresses.csv"

/**
 * The md5 and byte count the dataset record states for that edition, as read on 2026-10-02.
 */
const EDITION_MD5 = "c2df2f3c18b846144bb5d5dc57fc14ca"
const EDITION_BYTES = 28_186_970

/**
 * The UTF-8 byte-order mark the published file opens with.
 *
 * Built from its code point rather than written into a string literal.
 * The character is invisible in source, so a reader cannot tell a fixture
 * that has it from one that does not.
 */
const BYTE_ORDER_MARK = String.fromCodePoint(0xfe_ff)

/**
 * The dataset record, narrowed to what the module reads, with the five resources the portal lists.
 */
function datasetRecord(overrides: Record<string, unknown> = {}) {
	return {
		resources: [
			{ format: "json", url: "https://apiv3.geoportail.lu/geocode/reverse" },
			{ format: "json", url: "https://apiv3.geoportail.lu/geocode/search" },
			{ format: "geojson", url: "https://download.data.public.lu/…/addresses.geojson", filesize: 80_836_067 },
			{ format: "zip", url: "https://download.data.public.lu/…/addresses-shp.zip", filesize: 19_681_289 },
			{
				format: "csv",
				url: EDITION_URL,
				filesize: EDITION_BYTES,
				checksum: { type: "md5", value: EDITION_MD5 },
				last_modified: "2026-09-28T02:31:20+00:00",
				...overrides,
			},
		],
	}
}

function stubClient(results: StubResult[]): APIClient & { calls: string[] } {
	const transport = stubTransport(results)
	const client = new APIClient({ displayName: "bd-adresses test", logger: silentLogger(), axios: transport.axios })

	return Object.assign(client, { calls: transport.calls })
}

describe("readBDAdressesResource", () => {
	it("takes the csv resource rather than the first one listed", () => {
		const resource = readBDAdressesResource(datasetRecord())

		// The portal lists two geocoding APIs, a GeoJSON and a shapefile beside the CSV.
		expect(resource.url).toBe(EDITION_URL)
		expect(resource.filesize).toBe(EDITION_BYTES)
		expect(resource.md5).toBe(EDITION_MD5)
		expect(resource.lastModified).toBe("2026-09-28T02:31:20+00:00")
	})

	it("reads a digest of another type as none rather than comparing it as an md5", () => {
		const resource = readBDAdressesResource(datasetRecord({ checksum: { type: "sha1", value: "abc" } }))

		expect(resource.md5).toBeNull()
		expect(resource.url).toBe(EDITION_URL)
	})

	it("reports a record naming no csv resource rather than downloading nothing", () => {
		expect(() =>
			readBDAdressesResource({
				resources: [{ format: "geojson", url: "https://download.data.public.lu/…/addresses.geojson" }],
			})
		).toThrow(/names no csv resource/)

		expect(() => readBDAdressesResource({})).toThrow(/\(none\)/)
	})
})

describe("the header check over the publisher's semicolons", () => {
	it("reads the column names through the byte-order mark the file opens with", async () => {
		await using scratch = await temporaryDirectory("mailwoman-bd-adresses-header-")
		const path = scratch.path(LU_BD_ADRESSES_CSV_FILENAME)

		await writeLocalFile(
			`${BYTE_ORDER_MARK}rue;numero;localite;code_postal;id_caclr_rue;id_caclr_bat;id_geoportail\n` +
				"Kaesfurterstrooss;20;Hupperdange;9755;7984;210309;058F00436002710_7984_20\n",
			path
		)

		const columns = await readDelimitedHeader(path, LU_BD_ADRESSES_DELIMITER)

		expect(columns[0]).toBe("rue")
		expect(() => assertHeaderColumns(columns, BD_ADRESSES_REQUIRED_COLUMNS, "ctx")).not.toThrow()
	})

	it("names a renamed column rather than letting the adapter read it as an empty string", async () => {
		await using scratch = await temporaryDirectory("mailwoman-bd-adresses-renamed-")
		const path = scratch.path(LU_BD_ADRESSES_CSV_FILENAME)

		await writeLocalFile(`${BYTE_ORDER_MARK}rue;numero;localite;cp;id_caclr_rue;id_geoportail\n`, path)

		const columns = await readDelimitedHeader(path, LU_BD_ADRESSES_DELIMITER)

		expect(() => assertHeaderColumns(columns, BD_ADRESSES_REQUIRED_COLUMNS, "bd-adresses")).toThrow(/code_postal/)
	})

	it("would misread the header on a comma, which is why the delimiter is passed", async () => {
		await using scratch = await temporaryDirectory("mailwoman-bd-adresses-comma-")
		const path = scratch.path(LU_BD_ADRESSES_CSV_FILENAME)

		await writeLocalFile(`${BYTE_ORDER_MARK}rue;numero;localite;code_postal;id_caclr_rue;id_geoportail\n`, path)

		expect(await readDelimitedHeader(path)).toEqual(["rue;numero;localite;code_postal;id_caclr_rue;id_geoportail"])
	})
})

describe("downloadBDAdresses", () => {
	it("transfers nothing when the manifest already records the stated md5", async () => {
		await using scratch = await temporaryDirectory("mailwoman-bd-adresses-skip-")
		const csvPath = scratch.path(LU_BD_ADRESSES_CSV_FILENAME)

		await writeLocalFile(`${BYTE_ORDER_MARK}rue;numero\nKaesfurterstrooss;20\n`, csvPath)

		const manifest: BDAdressesManifest = {
			source_url: EDITION_URL,
			downloaded_at: "2026-10-02T06:00:00.000Z",
			filename: LU_BD_ADRESSES_CSV_FILENAME,
			sha256: await sha256File(csvPath),
			bytes: EDITION_BYTES,
			license: "CC0-1.0",
			attribution: "Administration du cadastre et de la topographie",
			dataset_url: "https://data.public.lu/api/1/datasets/adresses-georeferencees-bd-adresses/",
			publisher_md5: EDITION_MD5,
			publisher_filesize: EDITION_BYTES,
			last_modified: "2026-09-28T02:31:20+00:00",
			columns: BD_ADRESSES_REQUIRED_COLUMNS,
		}

		await writeManifest(scratch.path("MANIFEST.json"), manifest)

		await using client = stubClient([{ body: datasetRecord() }])

		const summary = await downloadBDAdresses(client, { outputDir: scratch.path() })

		// One request, to the dataset record, and no transfer of the 28 MB body.
		expect(summary).toMatchObject({ fetched: 0, skipped: 1, failed: 0 })
		expect(client.calls).toHaveLength(1)
	})

	it("reports a dataset record it cannot read rather than writing an empty file", async () => {
		await using scratch = await temporaryDirectory("mailwoman-bd-adresses-no-csv-")

		await using client = stubClient([
			{ body: { resources: [{ format: "geojson", url: "https://example.invalid/x" }] } },
		])

		const lines: string[] = []
		const summary = await downloadBDAdresses(client, { outputDir: scratch.path(), report: (line) => lines.push(line) })

		expect(summary).toMatchObject({ fetched: 0, skipped: 0, failed: 1, failedCodes: ["bd-adresses"] })
		expect(lines.join("\n")).toMatch(/names no csv resource/)
	})
})
