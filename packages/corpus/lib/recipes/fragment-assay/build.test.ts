/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file One seeded `fragment-assay` build over the Python parity test's fixture, compared row by row in emission
 *   order with `fixtures/builders/fragment-assay/fragment-build-reference.json`, which the Python builder wrote.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { resolvePackagePath } from "@mailwoman/core/module/resolvers"
import { JSONSpliterator } from "spliterator"
import { describe, expect, it } from "vitest"

import { readParquetRows } from "#parquet/readers"
import { ParquetColumnKind, writeColumnParquetFile } from "#parquet/writers"
import { buildFragmentAssay, type FragmentAssayOptions } from "#recipes/fragment-assay/build"
import {
	collectOAParts,
	collectRyhtiParts,
	FRAGMENT_SOURCE,
	OA_FILES,
	OA_LOCALES,
	RYHTI_REGISTER_ROW,
} from "#recipes/fragment-assay/sources"
import { mappingInputsFor, readCorpusSourceInputs, sourceRightsGaps } from "#source-register/corpus-inputs"
import { readAddressSourceRegister } from "#source-register/register"

const REFERENCE = resolvePackagePath(
	"@mailwoman/corpus",
	"fixtures",
	"builders",
	"fragment-assay",
	"fragment-build-reference.json"
)

interface IdentifiedRow {
	source_id: string
	country: string
	raw: string
}

const OA_FIXTURE_FILES: Record<string, string[][]> = {
	"cz/countrywide.csv": [
		["Hauptstrasse", "12", "Wien", "1010", "3"],
		["Ringstrasse", "7", "Graz", "8010", ""],
		["Bahnhofplatz", "21", "Linz", "4020", "2"],
	],
	"au/countrywide.csv": [
		["Bouverie Street", "139", "Melbourne", "3000", "711"],
		["George Street", "45", "Sydney", "2000", ""],
		["Adelaide Terrace", "88", "Perth", "6000", "4"],
	],
}

const CORPUS_SPECS: [string, string, [string, string][]][] = [
	[
		"US",
		"350 5th Ave, New York, NY 10118",
		[
			["5th Ave", "street"],
			["New York", "locality"],
			["NY", "region"],
		],
	],
	[
		"US",
		"1 N Hartland Rd, White River Junction, VT 05001",
		[
			["N Hartland Rd", "street"],
			["White River Junction", "locality"],
			["VT", "region"],
		],
	],
	[
		"FR",
		"12 Rue de Rivoli, Paris",
		[
			["Rue de Rivoli", "street"],
			["Paris", "locality"],
		],
	],
	[
		"NO",
		"5 Vestre Haugen, Oslo",
		[
			["Vestre Haugen", "street"],
			["Oslo", "locality"],
		],
	],
]

function corpusRow([country, raw, fields]: (typeof CORPUS_SPECS)[number]) {
	const starts: number[] = []
	const ends: number[] = []
	let cursor = 0

	for (const [surface] of fields) {
		const start = raw.indexOf(surface, cursor)

		cursor = start + surface.length
		starts.push(start)
		ends.push(cursor)
	}

	return { raw, span_starts: starts, span_ends: ends, span_tags: fields.map(([, tag]) => tag), country }
}

const csv = (rows: readonly (readonly string[])[]) => rows.map((row) => row.join(","))

async function writeFixture(root: string): Promise<FragmentAssayOptions> {
	for (const [relative] of Object.values(OA_FILES).flat()) {
		await writeLocalTextFile(
			csv([["STREET", "NUMBER", "CITY", "POSTCODE", "UNIT"], ...(OA_FIXTURE_FILES[relative] ?? [])]),
			`${root}/openaddresses/${relative}`
		)
	}

	const rows = CORPUS_SPECS.map(corpusRow)

	await writeColumnParquetFile(
		[...rows, ...rows, ...rows, ...rows],
		[
			["raw", ParquetColumnKind.String],
			["span_starts", ParquetColumnKind.Int32List],
			["span_ends", ParquetColumnKind.Int32List],
			["span_tags", ParquetColumnKind.StringList],
			["country", ParquetColumnKind.String],
		],
		`${root}/corpus/part-0000.parquet`
	)

	await writeLocalTextFile(["Dublin", "Melbourne", "Casablanca"], `${root}/famous.txt`)

	return {
		oaRoot: `${root}/openaddresses`,
		corpusParquetGlob: `${root}/corpus/part-0000.parquet`,
		famousLocalitiesFile: `${root}/famous.txt`,
		localityParquetGlob: "",
		ryhtiFile: "",
		outParquet: `${root}/out/part-fragment.parquet`,
		outDev: `${root}/out/fragment-dev.jsonl`,
		perLocaleCap: 4,
	}
}

const RYHTI_ROWS = [
	["address_fin", "address_swe", "postal_office_fin", "address_name_fin", "postal_code"],
	["Vuorijärventie 216", "", "YLÄ-KOLKKI", "Vuorijärventie", "42830"],
	["", "Storgatan 3", "", "", "65100"],
	["Hämeenkatu 12 a", "", "TAMPERE", "Hämeenkatu", "33100"],
]

describe("the fragment-assay build", () => {
	it("writes the Python builder's rows, in emission order, and its dev holdout", async () => {
		const reference = await readLocalJSONFile<{ train: IdentifiedRow[]; dev: IdentifiedRow[] }>(REFERENCE)

		await using scratch = await temporaryDirectory("mailwoman-fragment-")
		const options = await writeFixture(scratch.path.toString())

		await buildFragmentAssay(options)

		const train = await readParquetRows<IdentifiedRow>(options.outParquet, { columns: ["source_id", "country", "raw"] })

		const dev = await Array.fromAsync(
			JSONSpliterator.fromAsync<IdentifiedRow & Record<string, unknown>>(options.outDev)
		)

		expect(train).toEqual(reference.train)
		expect(dev.map(({ source_id, country, raw }) => ({ source_id, country, raw }))).toEqual(reference.dev)
		expect(dev).toHaveLength(Math.floor((train.length + dev.length) / 10))
	})

	it("emits Finnish rows from Ryhti, taking the number from the published rendering", async () => {
		await using scratch = await temporaryDirectory("mailwoman-fragment-")
		const ryhti = scratch.path("open_address.csv").toString()

		await writeLocalTextFile(csv(RYHTI_ROWS), ryhti)

		const parts = await collectRyhtiParts(ryhti, 4)

		expect(parts.pairs.toSorted()).toEqual([
			["Hämeenkatu", "12 a"],
			["Vuorijärventie", "216"],
		])

		expect(parts.cities.toSorted()).toEqual(["TAMPERE", "YLÄ-KOLKKI"])
		expect(parts.units).toEqual([])

		const options = { ...(await writeFixture(scratch.path.toString())), ryhtiFile: ryhti }

		await buildFragmentAssay(options)

		const rows = [
			...(await readParquetRows<Record<string, unknown>>(options.outParquet)),
			...(await Array.fromAsync(JSONSpliterator.fromAsync<Record<string, unknown>>(options.outDev))),
		].filter((row) => row["country"] === "FI")

		expect(new Set(rows.map((row) => row["register"]))).toEqual(new Set(["ryhti"]))
		expect(rows.map((row) => row["raw"])).toContain("Vuorijärventie 216")
	})

	it("refuses an absent listed OpenAddresses file, naming it", async () => {
		await using scratch = await temporaryDirectory("mailwoman-fragment-")

		await expect(collectOAParts(scratch.path.toString(), "cz", 4)).rejects.toThrow("cz/countrywide.csv")
	})

	it("refuses an absent Ryhti file, naming it", async () => {
		await using scratch = await temporaryDirectory("mailwoman-fragment-")
		const path = scratch.path("open_address.csv").toString()

		await expect(collectRyhtiParts(path, 4)).rejects.toThrow(path)
	})

	it("reads only files whose register row the source's input table maps, and the source has no rights gap", async () => {
		const register = await readAddressSourceRegister()
		const inputs = await readCorpusSourceInputs(register)

		const mapped = new Set(
			mappingInputsFor(inputs.resolve(FRAGMENT_SOURCE)!.mapping).map((input) => input.registerSource)
		)

		const named = new Set([
			...Object.values(OA_FILES).flatMap((files) => files.map(([, row]) => row)),
			RYHTI_REGISTER_ROW,
		])

		expect(Object.keys(OA_FILES).toSorted()).toEqual(Object.keys(OA_LOCALES).toSorted())
		expect([...named].filter((row) => !mapped.has(row))).toEqual([])
		expect(sourceRightsGaps(FRAGMENT_SOURCE, inputs, register)).toEqual([])
	})
})
