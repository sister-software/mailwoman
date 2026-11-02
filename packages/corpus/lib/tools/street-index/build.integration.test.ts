/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { afterAll, describe, expect, it } from "vitest"

import type { ParquetRow } from "#parquet/schema"
import { writeParquetFile } from "#parquet/writers"
import { CorpusStreetIndex } from "#street-index/reader"
import { buildStreetIndex, premiseRegisters } from "#tools/street-index/build"

const root = await temporaryDirectory("mw-street-index-")

afterAll(() => root[Symbol.asyncDispose]())

const FIXTURE_DERIVATION = { extractHash: "fixture", codeHash: "fixture", config: {} }

/**
 * A FR row `<number> <prefix> <street>, <postcode> <locality>` from `register`.
 */
function frRow(sourceID: string, raw: string, register: string, source = "ban"): ParquetRow {
	const [line, place] = raw.split(", ") as [string, string]
	const [number, prefix, ...name] = line.split(" ")
	const street = name.join(" ")
	const prefixStart = number!.length + 1
	const streetStart = prefixStart + prefix!.length + 1
	const placeStart = line.length + 2
	const localityStart = placeStart + place.indexOf(" ") + 1

	return {
		raw,
		tokens: raw.split(" "),
		labels: raw.split(" ").map(() => "O"),
		span_starts: [0, prefixStart, streetStart, placeStart, localityStart],
		span_ends: [
			number!.length,
			prefixStart + prefix!.length,
			streetStart + street.length,
			localityStart - 1,
			raw.length,
		],
		span_tags: ["house_number", "street_prefix", "street", "postcode", "locality"],
		country: "FR",
		locale: "fr-FR",
		source,
		source_id: sourceID,
		license: "Licence Ouverte 2.0",
		register,
		surface: "rendered",
		augmentation: null,
		base_source_id: null,
	}
}

describe("buildStreetIndex", () => {
	it("reads the premise registers from the adapters that declare them", () => {
		const registers = premiseRegisters()

		expect(registers.has("fr-ban")).toBe(true)
		expect(registers.has("us-dot-nad")).toBe(true)
		expect(registers.has("us-nppes")).toBe(false)
	})

	it("indexes each premise-register street line by country and locality, and leaves other registers out", async () => {
		const banFile = root.path("ban.parquet")
		const otherFile = root.path("other.parquet")
		const manifest = root.path("MANIFEST.json")
		const out = root.path("street-index.db")

		await writeParquetFile(
			[
				frRow("b1", "2 Rue du Général Charles de Gaulle, 20110 Propriano", "fr-ban"),
				frRow("b2", "4 Rue du Général Charles de Gaulle, 20110 Propriano", "fr-ban"),
			],
			banFile,
			FIXTURE_DERIVATION
		)

		await writeParquetFile(
			[frRow("o1", "9 Chemin de la, 37250 Sorigny", "eu-cordis-participants", "cordis")],
			otherFile,
			FIXTURE_DERIVATION
		)

		await writeLocalJSONFile({ files: [{ path: banFile.toString() }, { path: otherFile.toString() }] }, manifest)

		const report = await buildStreetIndex({ manifest, out, limits: { threads: 1 } })

		expect(report.rows).toBe(1)
		expect(report.byCountry).toEqual({ FR: 1 })

		using index = new CorpusStreetIndex(out, "FR")

		expect(index.hasStreetName("Rue du General Charles de Gaulle", { locality: "Propriano" })).toBe(true)
		expect(index.hasStreetName("rue du général charles de gaulle")).toBe(true)
		expect(index.hasStreetName("Chemin de la")).toBe(false)
		expect(new CorpusStreetIndex(out, "BE").hasStreetName("Rue du General Charles de Gaulle")).toBe(false)
	})
})
