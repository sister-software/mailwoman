/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file `coverage-census` — the readers that decide what mailwoman is reported to support.
 *
 *   Every failure this file pins is silent: an answer that is wrong and confident rather than thrown.
 */

import { readLocalJSONFile, pathExists } from "@mailwoman/core/fs/readers"
import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import { makeDirectories, writeLocalFile, writeLocalJSONFile, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { dataRootPath } from "@mailwoman/core/data-root"
import { repoRootPath } from "@mailwoman/core/paths"
import { readScopeConfig, shippedTrainingConfigs } from "@mailwoman/core/scope-config"
import {
	buildCorpusCensus,
	ConfigProvenance,
	DEFAULT_ADMISSION_FAMILY,
	newestManifest,
	normalizeArrowListColumn,
	readAdmittedCountries,
	readBoardCoverage,
	readConfiguredCorpusVersion,
	resolveTrainingConfig,
	sameCorpusVersion,
} from "#coverage"
import { utimes } from "node:fs/promises"
import type { PathBuilder } from "path-ts"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { stringifyJSON } from "@mailwoman/core/json";

const fixtures = new AsyncDisposableStack()

afterAll(() => fixtures.disposeAsync())

let root: PathBuilder

beforeAll(async () => {
	root = fixtures.use(await temporaryDirectory("mw-coverage-")).path
})

describe("normalizeArrowListColumn", () => {
	it("normalizes both plain and nested Arrow list representations", () => {
		expect(normalizeArrowListColumn(["B-street", "I-street"], "labels")).toEqual(["B-street", "I-street"])

		expect(normalizeArrowListColumn({ list: [{ element: "B-street" }, { element: "I-street" }] }, "labels")).toEqual([
			"B-street",
			"I-street",
		])
	})

	it("refuses an absent or unreadable requested column", () => {
		expect(() => normalizeArrowListColumn(undefined, "labels")).toThrow(/absent or unreadable/)
		expect(() => normalizeArrowListColumn({ list: {} }, "labels")).toThrow(/partial row/)
		expect(() => normalizeArrowListColumn({ list: [{ value: "B-street" }] }, "labels")).toThrow(/partial row/)
	})
})

describe("readAdmittedCountries", () => {
	it("keeps a bare NO as the string it is", async () => {
				// YAML 1.1 resolves a bare `no` to boolean false.
				// That result would report Norway as unadmitted even though the config lists it.
						const path = root("norway.yaml")

		await writeLocalTextFile(
			"data:\n  country_weights:\n    US: 1.0\n    NO: 1.0\n    FR: 1.0\n  source_weights:\n    x: 1.0\n",
			path
		)

		const admitted = await readAdmittedCountries(path)

		expect(admitted.has("NO")).toBe(true)
		expect(admitted.size).toBe(3)
	})

	it("reads every pair of a flow-style mapping, many to a line", async () => {
		const path = root("flow.yaml")

		await writeLocalTextFile(
			"data:\n  country_weights:\n    {\n      AD: 1.0, AE: 1.0, AF: 0.0,\n" +
				'      "NO": 1.0, US: 2.0, # a comment naming XX: 1.0\n    }\n  source_weights:\n    x: 1.0\n',
			path
		)

		const admitted = await readAdmittedCountries(path)

		expect([...admitted].toSorted()).toEqual(["AD", "AE", "NO", "US"])
	})

	it("reads a QUOTED code the same as a bare one", async () => {
		const path = root("quoted.yaml")

		await writeLocalTextFile(
			'data:\n  country_weights:\n    "NO": 1.0\n    US: 1.0\n  source_weights:\n    x: 1.0\n',
			path
		)

		expect([...(await readAdmittedCountries(path))].toSorted()).toEqual(["NO", "US"])
	})

	it("treats a zero weight as NOT admitted", async () => {
		// The loader drops on `weight is None or weight <= 0`, so a zero is a drop and must not read as coverage.
		const path = root("zero.yaml")

		await writeLocalTextFile("data:\n  country_weights:\n    US: 1.0\n    GB: 0\n  source_weights:\n    x: 1.0\n", path)

		const admitted = await readAdmittedCountries(path)

		expect(admitted.has("US")).toBe(true)
		expect(admitted.has("GB")).toBe(false)
	})

	it("stops at the end of the block rather than swallowing the next section", async () => {
		const path = root("bounded.yaml")

		await writeLocalTextFile(
			"data:\n  country_weights:\n    US: 1.0\n  source_weights:\n    gb: 4.0\n    fr: 2.0\n",
			path
		)

				// `gb` and `fr` are source weights that happen to be two letters. reading
				// past the block would report them as admitted countries.
				expect([...(await readAdmittedCountries(path))]).toEqual(["US"])
	})

	it("throws on a missing config rather than answering with an empty admitted set", async () => {
			// An empty set is a real answer, so returning it for an unreadable file
			// would give one value for two different facts.
								await expect(readAdmittedCountries(root("nope.yaml"))).rejects.toThrow(/no training config at/)
	})
})

describe("readBoardCoverage", () => {
	beforeAll(async () => {
		const cases = root("cases")

		await makeDirectories(cases("gb"))
		await makeDirectories(cases("generalization"))

		await writeLocalTextFile(
			[
				stringifyJSON({ id: "a", country: "GB", status: "pass" }),
				stringifyJSON({ id: "b", country: "GB", status: "improvement_target" }),
				stringifyJSON({ id: "c", country: "IE", status: "pass" }),
			],
			cases("gb", "regression.jsonl")
		)

		await makeDirectories(cases("gb", "archived"))
		await writeLocalJSONFile({ id: "archived", country: "GB", status: "pass" }, cases("gb", "archived", "old.jsonl"))

				// The loader's /^[a-z]{2}$/ filter excludes this directory.
				// A glob would include it and overstate the board.
				await writeLocalJSONFile({ id: "z", country: "ZZ", status: "pass" }, cases("generalization", "passes.jsonl"))
	})

	it("counts PASSING rows apart from tracked ones", async () => {
				// A country whose rows are all `improvement_target` has no verified row,
				// so its row count must not read as coverage.
				const board = await readBoardCoverage(root("cases"))

		expect(board.get("GB")).toEqual({ rows: 2, passed: 1 })
	})

	it("ignores nested country files the board loader does not read", async () => {
		expect((await readBoardCoverage(root("cases"))).get("GB")).toEqual({ rows: 2, passed: 1 })
	})

	it("attributes a row by its own country field, not its directory", async () => {
 // Board rows include their country explicitly even though the directory also encodes one.
				// Those values can disagree.
				expect((await readBoardCoverage(root("cases"))).get("IE")).toEqual({ rows: 1, passed: 1 })
	})

	it("skips the generalization directory the loader itself skips", async () => {
		expect((await readBoardCoverage(root("cases"))).has("ZZ")).toBe(false)
	})

	it("returns nothing rather than throwing when the cases tree is absent", async () => {
		expect((await readBoardCoverage(root("no-cases"))).size).toBe(0)
	})
})

/**
 * The corpus is a build artifact rather than a fixture, so this leg runs only where one exists.
 */
const CORPUS = dataRootPath(
	"corpus",
	"versioned",
	"v0.26.0-trailing-region-leftcontext",
	"corpus-v0.26.0-trailing-region-leftcontext",
	"MANIFEST.json"
)

describe.skipIf(!(await pathExists(CORPUS)))("buildCorpusCensus against a real database", () => {
	it("counts street rows on a database whose PROJECTION drops the labels column", async () => {
 // `getCursor(["country", "labels"])` returns only `{country}` on the v0.17.0-era writer's
				// databases, so a dropped label column must not read as "this country has no street rows".
												const manifest = await readLocalJSONFile<Record<string, unknown>>(CORPUS)

				// The manifest key has two live spellings on disk, so the test accepts either
				// rather than skipping on the ones it cannot name.
								const entries = (manifest["slices"] ?? manifest["sh" + "ards"]) as
			| Array<{ split?: string; path: string }>
			| undefined

		expect(entries, `${CORPUS} names its parquet files under neither accepted key`).toBeDefined()

		const one = entries!.filter((s) => s.split === "train" && s.path.includes("v0.17.0-batch")).slice(0, 1)

		expect(one).toHaveLength(1)

		await using directory = await temporaryDirectory("mw-census-real-")
		const scratch = directory.path("MANIFEST.json")

				// Only the one file under the current key: spreading the manifest would leave
				// its full list in place and the census would read all of it.
				await writeLocalJSONFile({ corpus_version: manifest["corpus_version"], slices: one }, scratch)

		const census = await buildCorpusCensus(scratch)

		expect(census.total).toBeGreaterThan(0)
		expect(census.streetRows["GB"] ?? 0).toBeGreaterThan(0)
	}, 120_000)
})

describe("buildCorpusCensus refuses an empty count", () => {
	it("throws rather than reporting zero rows for a manifest that lists train files", async () => {
			// A manifest naming train files and a total of zero cannot both be true,
			// so the zero is the instrument failing rather than a measurement.
								await using directory = await temporaryDirectory("mw-census-empty-")
		const scratch = directory.path("MANIFEST.json")

		await writeLocalJSONFile(
			{
				corpus_version: "v0.0.0-absent",
				slices: [{ split: "train", path: "/data/corpus/versioned/v0.0.0-absent/nothing-here-00000.parquet" }],
			},
			scratch
		)

		await expect(buildCorpusCensus(scratch)).rejects.toThrow(/Refusing to report an empty corpus/)
	})

	it("refuses to pick between two manifests sharing the newest modification time", async () => {
			// An mtime tie is what a fresh checkout or bulk copy produces, so this returns neither
			// rather than one arm's numbers under the other's name.
						await using directory = await temporaryDirectory("mw-census-tie-")
		const versionedRoot = directory.path("corpus", "versioned")
		const paths: string[] = []

		for (const version of ["v0.9.9-one", "v0.26.0-two"]) {
			const manifest = versionedRoot(version, `corpus-${version}`, "MANIFEST.json").toString()

			await writeLocalJSONFile({ corpus_version: version, slices: [] }, manifest)
			paths.push(manifest)
		}

		const shared = new Date("2026-09-20T12:00:00Z")

		for (const path of paths) {
			await utimes(path, shared, shared)
		}

		vi.stubEnv("MAILWOMAN_DATA_ROOT", directory.path.toString())

		try {
			await expect(newestManifest()).rejects.toThrow(/share the newest modification time/)
		} finally {
			vi.unstubAllEnvs()
		}
	})

	it("answers zero for a manifest that lists no train files at all", async () => {
				// A corpus whose manifest names no train file holds no train rows,
				// so zero is the measurement rather than a failure to read.
				await using directory = await temporaryDirectory("mw-census-none-")
		const scratch = directory.path("MANIFEST.json")

		await writeLocalJSONFile({ corpus_version: "v0.0.0-empty", slices: [] }, scratch)

		const census = await buildCorpusCensus(scratch)

		expect(census.total).toBe(0)
		expect(census.filesListed).toBe(0)
		expect(census.unreadableFiles).toEqual([])
	})
})

describe("sameCorpusVersion", () => {
	it("reads the prefixed and unprefixed spellings of one corpus as the same corpus", () => {
				// A manifest writes `v0.31.0-region-code-and-unit` and `readConfiguredCorpusVersion` strips
				// the prefix, so a raw comparison would declare a mismatch on every correct pairing.
						expect(sameCorpusVersion("0.31.0-region-code-and-unit", "v0.31.0-region-code-and-unit")).toBe(true)
		expect(sameCorpusVersion("v0.31.0-region-code-and-unit", "0.31.0-region-code-and-unit")).toBe(true)
		expect(sameCorpusVersion("v8-cjk-2026-09-05", "v8-cjk-2026-09-05")).toBe(true)
	})

	it("still separates two different corpora", () => {
		expect(sameCorpusVersion("0.31.0-region-code-and-unit", "v0.32.0-locality-shape")).toBe(false)
		expect(sameCorpusVersion("v0.30.0-bare-postcode", "0.31.0-region-code-and-unit")).toBe(false)
	})
})

describe("readConfiguredCorpusVersion", () => {
			/**
		 * The reader opens the file by path, so the temporary directory has to outlive this helper.
		 */
	async function config(body: string): Promise<TemporaryDirectory & { configPath: PathBuilder }> {
		const scratch = await temporaryDirectory("mw-cfg-")
		const configPath = scratch.path("c.yaml")

		await writeLocalFile(body, configPath)

		return scratch.moveWith({ configPath })
	}

	it("reads the version out of a versioned corpus_dir", async () => {
		// The config names 0.27.0 while a cached census counted 0.26.0, so every row count
		// would silently answer about the corpus that was counted.
						await using scratch = await config(
			"data:\n  corpus_dir: /data/corpus/versioned/v0.27.0-house-venue-intl/corpus-v0.27.0-house-venue-intl\n"
		)

		expect(await readConfiguredCorpusVersion(scratch.configPath)).toBe("0.27.0-house-venue-intl")
	})

	it("returns undefined rather than a guess when the config states no corpus_dir", async () => {
				// "Cannot check" is not "they match", so a plausible default would manufacture agreement.
				await using scratch = await config("data:\n  max_length: 128\n")

		expect(await readConfiguredCorpusVersion(scratch.configPath)).toBeUndefined()
		expect(await readConfiguredCorpusVersion("/nonexistent-config.yaml")).toBeUndefined()
	})

	it("falls back to the trailing directory when the path is not /versioned/-shaped", async () => {
		await using scratch = await config("data:\n  corpus_dir: /data/corpus/corpus-v0.5.0\n")

		expect(await readConfiguredCorpusVersion(scratch.configPath)).toBe("0.5.0")
	})
})

describe("readAdmittedCountries — the Norway shape", () => {
	it("keeps a QUOTED NO as the string it is, and counts it", async () => {
							// A YAML parser turns a bare `no` key into boolean false.
							// This reader preserves the key as text.
						// A quoted "no" must still be counted.
								await using scratch = await temporaryDirectory("mw-cfg-no-")
		const path = scratch.path("c.yaml")

		await writeLocalTextFile('data:\n  country_weights:\n    US: 1.0\n    "NO": 1.0\n    FR: 1.0\n', path)

		const admitted = await readAdmittedCountries(path)

		expect(admitted.has("NO")).toBe(true)
		expect(admitted.size).toBe(3)
	})

	it("does not admit a country at weight zero — that is a hard drop, not a low weight", async () => {
		await using scratch = await temporaryDirectory("mw-cfg-zero-")
		const path = scratch.path("c.yaml")

		await writeLocalTextFile("data:\n  country_weights:\n    US: 1.0\n    PE: 0\n", path)

		expect((await readAdmittedCountries(path)).has("PE")).toBe(false)
	})
})

describe("resolveTrainingConfig", () => {
	/**
	 * A register holding one family, enough to exercise every branch without
	 * reading the repository's own file.
	 */
	const scope = {
		tiers: {},
		dRuleProtected: {},
		untieredShippingLocales: {},
		trainingConfigs: {
			"en-us": {
				config: "corpus-python/src/mailwoman_train/configs/fixture-latin.yaml",
				graphPackage: "@mailwoman/neural-weights-en-us",
				readFrom: "model_lineage",
			},
			cjk: {
				config: "corpus-python/src/mailwoman_train/configs/fixture-char.yaml",
				graphPackage: "@mailwoman/neural-weights-cjk",
				readFrom: "training.run",
			},
		},
	}

	it("marks a caller-named config `given` and leaves the path untouched", () => {
		const resolved = resolveTrainingConfig(scope, { requested: "/tmp/whatever.yaml" })

		expect(resolved.path).toBe("/tmp/whatever.yaml")
		expect(resolved.provenance).toBe(ConfigProvenance.Given)
		expect(resolved.family).toBeUndefined()
	})

	it("takes the Latin family's config when the caller names none", () => {
		const resolved = resolveTrainingConfig(scope)

		expect(resolved.path.endsWith("fixture-latin.yaml")).toBe(true)
		expect(resolved.provenance).toBe(ConfigProvenance.Registered)
		expect(resolved.family).toBe(DEFAULT_ADMISSION_FAMILY)
	})

	it("reads a named family rather than the default", () => {
		expect(resolveTrainingConfig(scope, { family: "cjk" }).path.endsWith("fixture-char.yaml")).toBe(true)
	})

	it("throws for a family the register does not name, rather than answering with another family's config", () => {
				// A Latin config would report 25 Latin admissions under a third family's name.
				// Later stages would accept that mismatched report.
				expect(() => resolveTrainingConfig(scope, { family: "deva" })).toThrow(/names no training config/)
	})
})

describe("scope.config.json's registered training configs", () => {
	it("names a file that exists for every family, because the admission count is read out of it", async () => {
		const registered = shippedTrainingConfigs(await readScopeConfig())

		expect(registered.length).toBeGreaterThan(0)

		for (const entry of registered) {
			const path = repoRootPath(...entry.config.split("/"))

			expect(await pathExists(path)).toBe(true)
		}
	})
})
