/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { writeLocalBuffer } from "@mailwoman/core/fs/writers"
import ADMZip from "adm-zip"
import { describe, expect, it } from "vitest"

import {
	componentsForLLVRecord,
	createLLVLiechtensteinAdapter,
	LLV_LI_ADAPTER_ID,
	LLV_LI_LICENSE,
	type LLVLiechtensteinRecord,
} from "#li/adapters/llv/adapter"
import { runAdapter } from "#runner"
import { readCanonicalRows, useScratchDir } from "#test-kit"

const scratch = useScratchDir("llv-li")

const HEADER =
	"ADR_EGAID;STR_ESID;BDG_EGID;ADR_EDID;STN_NAME;ADR_NUMBER;COM_FOSNR;ZIP_ZIP4;ZIP_ZIPA;ZIP_NAME;STATUS;OFFICIAL;RELIABLE;EAST;NORTH;WGS84_N;WGS84_E;MODIFIED;AV_STRNR;FL_GEID"

/**
 * Lines copied from the Landesverwaltung's `dataset.csv`, which is Windows-1252, `;`-separated and unquoted.
 */
const LINES = [
	"299012092;89440006;299000583;1;Am Schrägen Weg;16;7001;9490;0;Vaduz;real;TRUE;TRUE;2757687.3;1222975.928;47.138963;9.517546;2009-12-22T00:00:00;440006;583",
	"299000202;89520068;299041211;1;Schulstrasse;42b;7007;9485;0;Nendeln;real;TRUE;TRUE;2759566.096;1229492.885;47.19711;9.54461;2019-01-17T00:00:00;520068;41211",
	"299004071;89450159;299090457;1;Valünastrasse;65;7005;9497;0;Triesenberg;real;TRUE;TRUE;2765154.225;1215655.492;47.07132;9.613264;2010-12-27T00:00:00;450159;90457",
	"299000403;89520350;299019665;1;Rheinau;696;7007;9487;0;Gamprin-Bendern;real;TRUE;TRUE;2755873.39;1230121.922;47.203648;9.496113;2010-01-12T00:00:00;520350;19665",
	"299000082;89520012;299042632;1;Churer Strasse;72;7007;9485;0;Nendeln;planned;TRUE;FALSE;2759290.929;1229381.937;47.196179;9.54094;2010-06-01T00:00:00;520012;42632",
	"299002262;89530009;299041764;1;Felbenweg;12c;7008;9493;0;Mauren;real;FALSE;FALSE;2759025.294;1231941.257;47.219255;9.53834;2021-06-28T00:00:00;530009;41764",
]

const parse = (line: string): LLVLiechtensteinRecord => {
	const keys = HEADER.split(";")
	const values = line.split(";")

	const row: Record<string, string> = Object.fromEntries(keys.map((key, index) => [key, values[index] ?? ""]))

	return {
		ADR_EGAID: row.ADR_EGAID ?? "",
		STN_NAME: row.STN_NAME ?? "",
		ADR_NUMBER: row.ADR_NUMBER ?? "",
		ZIP_ZIP4: row.ZIP_ZIP4 ?? "",
		ZIP_NAME: row.ZIP_NAME ?? "",
		STATUS: row.STATUS ?? "",
		OFFICIAL: row.OFFICIAL ?? "",
	}
}

describe("componentsForLLVRecord", () => {
	it("reads the street, the number with its letter, the postcode and the postal locality", () => {
		expect(componentsForLLVRecord(parse(LINES[0]!))).toEqual({
			street: "Am Schrägen Weg",
			house_number: "16",
			postcode: "9490",
			locality: "Vaduz",
		})

		expect(componentsForLLVRecord(parse(LINES[1]!))).toEqual({
			street: "Schulstrasse",
			house_number: "42b",
			postcode: "9485",
			locality: "Nendeln",
		})

		expect(componentsForLLVRecord(parse(LINES[3]!))?.locality).toBe("Gamprin-Bendern")
	})

	it("refuses a planned address and one the register marks as not official", () => {
		const dropped = new Map<string, number>()

		expect(componentsForLLVRecord(parse(LINES[4]!), { dropped })).toBeNull()
		expect(componentsForLLVRecord(parse(LINES[5]!), { dropped })).toBeNull()

		expect(Object.fromEntries(dropped)).toEqual({
			"row:status-planned": 1,
			"row:not-official": 1,
		})
	})

	it("drops a postcode outside the country's format but keeps the locality", () => {
		const dropped = new Map<string, number>()

		expect(componentsForLLVRecord({ ...parse(LINES[0]!), ZIP_ZIP4: "8000" }, { dropped })).toEqual({
			street: "Am Schrägen Weg",
			house_number: "16",
			locality: "Vaduz",
		})

		expect(Object.fromEntries(dropped)).toEqual({
			"component:postcode:not-country-format": 1,
		})
	})
})

describe("llv-li adapter", () => {
	it("decodes the Windows-1252 CSV, renders the LI layout and stamps the publisher's license", async () => {
		const file = scratch.path("dataset.csv")

		await writeLocalBuffer(Buffer.from([HEADER, ...LINES].join("\r\n") + "\r\n", "latin1"), file)

		const dropped = new Map<string, number>()

		const manifest = await runAdapter({
			adapter: createLLVLiechtensteinAdapter(),
			adapterOptions: { inputPath: file, country: "LI", dropped },
			outputDir: scratch.path,
			corpusVersion: "0.1.0",
		})

		expect(manifest.yielded).toBe(4)

		const rows = await readCanonicalRows(scratch.path, LLV_LI_ADAPTER_ID)

		expect(rows.every((row) => row.license === LLV_LI_LICENSE && row.country === "LI")).toBe(true)
		expect(rows.map((row) => row.raw)).toContain("Valünastrasse 65, FL-9497 Triesenberg")
		expect(new Set(rows.map((row) => row.source_id)).size).toBe(4)
	})

	it("reads dataset.csv from the publisher's ZIP", async () => {
		const zip = new ADMZip()

		zip.addFile("AbiOGDLizenz.pdf", Buffer.from("%PDF-1.4\n"))
		zip.addFile("dataset.csv", Buffer.from([HEADER, ...LINES.slice(0, 2)].join("\r\n") + "\r\n", "latin1"))

		const file = scratch.path("officialAdress.zip")

		await writeLocalBuffer(zip.toBuffer(), file)

		const rows = []

		for await (const row of createLLVLiechtensteinAdapter().rows({
			inputPath: file,
			country: "LI",
		})) {
			rows.push(row.raw)
		}

		expect(rows).toEqual(["Am Schrägen Weg 16, FL-9490 Vaduz", "Schulstrasse 42b, FL-9485 Nendeln"])
	})

	it("refuses another country", async () => {
		await expect(
			Array.fromAsync(createLLVLiechtensteinAdapter().rows({ inputPath: "unused.csv", country: "CH" }))
		).rejects.toThrow(/llv-li/u)
	})
})
