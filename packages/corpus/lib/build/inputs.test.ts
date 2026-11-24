// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { cacheRootPathBuilder, dataRootPath } from "@mailwoman/core/data-root"
import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { buildInputsPath, readBuildInputs, readSourceRuns, sourceRunDirectoryName } from "#build/inputs"

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

	it("resolves a current source's inputPath against the cache root and keeps every other input under the data root", async () => {
		const path = scratch.path("inputs.json")

		await writeLocalJSONFile(
			{
				corpusVersion: "v0.0.0-test",
				adapters: {
					ban: { inputPath: "sources/ban", root: "cache", streetIndex: "corpus/street-index/fr.json" },
					"usgov-nppes": { inputPath: "snapshots/usgov-nppes/2026-05", root: "data" },
				},
			},
			path
		)

		const inputs = await readBuildInputs(path)

		expect(inputs.ban).toEqual({
			inputPath: cacheRootPathBuilder("sources/ban").toString(),
			streetIndex: dataRootPath("corpus/street-index/fr.json").toString(),
		})

		expect(inputs["usgov-nppes"]).toEqual({ inputPath: dataRootPath("snapshots/usgov-nppes/2026-05").toString() })
	})

	it("refuses a root it does not know rather than resolving the input against the data root", async () => {
		const path = scratch.path("bad-root.json")

		await writeLocalJSONFile(
			{ corpusVersion: "v0.0.0-test", adapters: { ban: { inputPath: "sources/ban", root: "temp" } } },
			path
		)

		await expect(readBuildInputs(path)).rejects.toThrow(/adapter ban names root "temp"/)
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

		expect(inputs["wof-admin"]!.inputPath).toBe(dataRootPath("src", "wof-repos").toString())
	})
})

describe("readSourceRuns", () => {
	it("reads the committed overture-latam runs, one per country, each under the latam source name", async () => {
		const runs = await readSourceRuns(buildInputsPath("v0.8.23-rebuild"))

		expect(
			runs.map((run) => sourceRunDirectoryName({ sourceName: run.sourceName, country: run.options.country }))
		).toEqual(["overture-latam-br", "overture-latam-mx", "overture-latam-ca"])

		for (const run of runs) {
			expect(run.adapter).toBe("overture")

			expect(run.options.inputPath).toBe(
				dataRootPath(
					`corpus/staging/overture/2026-05-20.0/overture-${run.options.country!.toLowerCase()}.corpus.jsonl`
				).toString()
			)
		}
	})

	it("refuses two runs that would write one source and country", async () => {
		const path = scratch.path("repeated.json")
		const run = { adapter: "overture", sourceName: "overture-latam", country: "BR", inputPath: "x.jsonl" }

		await writeLocalJSONFile({ corpusVersion: "v0.0.0-test", adapters: {}, sourceRuns: [run, run] }, path)

		await expect(readSourceRuns(path)).rejects.toThrow(/source run 1 repeats overture-latam-br/)
	})

	it("refuses a run that names no source name, whose rows would take the adapter's own id", async () => {
		const path = scratch.path("unnamed.json")

		await writeLocalJSONFile(
			{ corpusVersion: "v0.0.0-test", adapters: {}, sourceRuns: [{ adapter: "overture", inputPath: "x.jsonl" }] },
			path
		)

		await expect(readSourceRuns(path)).rejects.toThrow(/source run 0 names no `sourceName`/)
	})
})
