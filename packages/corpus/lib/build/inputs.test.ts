/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { buildInputsPath, readBuildInputs } from "@mailwoman/corpus/build/inputs"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

let scratch: TemporaryDirectory

beforeEach(async () => {
	scratch = await temporaryDirectory("mailwoman-build-inputs-")
})

afterEach(async () => {
	await scratch[Symbol.asyncDispose]()
})

describe("readBuildInputs", () => {
	it("resolves a relative inputPath against the data root and keeps an absolute one", async () => {
		const path = scratch.path("inputs.json")

		await writeLocalJSONFile(
			{
				corpusVersion: "v0.0.0-test",
				adapters: {
					ban: { inputPath: "corpus/staging/ban-france.csv" },
					tiger: { inputPath: "/somewhere/else/tiger.db" },
					"oa-eu": { inputPath: "openaddresses/europe.zip", country: "DE", limit: 10 },
				},
			},
			path
		)

		const inputs = await readBuildInputs(path)

		expect(inputs.ban!.inputPath).toBe(dataRootPath("corpus/staging/ban-france.csv").toString())
		expect(inputs.tiger!.inputPath).toBe("/somewhere/else/tiger.db")

		expect(inputs["oa-eu"]).toEqual({
			inputPath: dataRootPath("openaddresses/europe.zip").toString(),
			country: "DE",
			limit: 10,
		})
	})

	it("refuses a record that names no adapter, which would build an empty corpus and report success", async () => {
		const path = scratch.path("empty.json")

		await writeLocalJSONFile({ corpusVersion: "v0.0.0-test", adapters: {} }, path)

		await expect(readBuildInputs(path)).rejects.toThrow(/names no adapter/)
	})

	it("refuses an adapter entry with no inputPath rather than reading zero rows for it", async () => {
		const path = scratch.path("partial.json")

		await writeLocalJSONFile({ corpusVersion: "v0.0.0-test", adapters: { ban: { country: "FR" } } }, path)

		await expect(readBuildInputs(path)).rejects.toThrow(/adapter ban has no `inputPath`/)
	})

	it("reads the committed v0.7.0-de-holdout record through the package's data export", async () => {
		const inputs = await readBuildInputs(buildInputsPath("v0.7.0-de-holdout"))

		// The eleven adapters that build recorded, in the manifest's own order.
		expect(Object.keys(inputs)).toEqual([
			"wof-admin",
			"wof-postalcode",
			"ban",
			"tiger",
			"usgov-hrsa-fqhc",
			"usgov-nppes",
			"usgov-nad",
			"usgov-imls-pls",
			"state-ia-contractors",
			"state-tx-notaries",
			"state-ny-notaries",
		])

		expect(inputs["wof-admin"]!.inputPath).toBe(dataRootPath("src", "wof-repos").toString())
	})
})
