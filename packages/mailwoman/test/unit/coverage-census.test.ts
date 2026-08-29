/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file `coverage-census` — the readers that decide what mailwoman is reported to support.
 *
 *   Each test here pins a way of getting the answer WRONG that has actually happened, because the failures in this
 *   file are all silent: a bare `NO` retyped to a boolean, a nested Arrow column read as a plain array, a glob that
 *   picks up a directory the loader excludes. None of them throws; each returns a confident number.
 */

import { parseJSONStrict } from "@mailwoman/core/objects"
import { dataRootPath } from "@mailwoman/core/utils"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "@mailwoman/platform/fs"
import { tmpdir } from "@mailwoman/platform/os"
import { join } from "@mailwoman/platform/path"
import {
	buildCorpusCensus,
	normalizeArrowListColumn,
	readAdmittedCountries,
	readBoardCoverage,
	readConfiguredCorpusVersion,
} from "mailwoman/coverage-census"
import { beforeAll, describe, expect, it } from "vitest"

let root: string

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "mw-coverage-"))
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
	it("keeps a bare NO as the string it is", () => {
		// YAML 1.1 resolves bare `NO` to boolean false. A YAML parser here would report Norway as un-admitted while the
		// config lists it — reproducing, inside the tool meant to SURFACE that bug, the bug itself.
		const path = join(root, "norway.yaml")

		writeFileSync(
			path,
			"data:\n  country_weights:\n    US: 1.0\n    NO: 1.0\n    FR: 1.0\n  source_weights:\n    x: 1.0\n"
		)

		const admitted = readAdmittedCountries(path)

		expect(admitted.has("NO")).toBe(true)
		expect(admitted.size).toBe(3)
	})

	it("reads a QUOTED code the same as a bare one", () => {
		const path = join(root, "quoted.yaml")

		writeFileSync(path, 'data:\n  country_weights:\n    "NO": 1.0\n    US: 1.0\n  source_weights:\n    x: 1.0\n')

		expect([...readAdmittedCountries(path)].toSorted()).toEqual(["NO", "US"])
	})

	it("treats a zero weight as NOT admitted", () => {
		// The loader drops on `weight is None or weight <= 0`, so a zero is a drop and must not read as coverage.
		const path = join(root, "zero.yaml")

		writeFileSync(path, "data:\n  country_weights:\n    US: 1.0\n    GB: 0\n  source_weights:\n    x: 1.0\n")

		const admitted = readAdmittedCountries(path)

		expect(admitted.has("US")).toBe(true)
		expect(admitted.has("GB")).toBe(false)
	})

	it("stops at the end of the block rather than swallowing the next section", () => {
		const path = join(root, "bounded.yaml")

		writeFileSync(path, "data:\n  country_weights:\n    US: 1.0\n  source_weights:\n    gb: 4.0\n    fr: 2.0\n")

		// `gb` and `fr` are SOURCE weights that happen to be two letters. Reading past the block would report them as
		// admitted countries.
		expect([...readAdmittedCountries(path)]).toEqual(["US"])
	})

	it("reports a missing config as no coverage rather than throwing", () => {
		expect(readAdmittedCountries(join(root, "nope.yaml")).size).toBe(0)
	})
})

describe("readBoardCoverage", () => {
	beforeAll(() => {
		const cases = join(root, "cases")

		mkdirSync(join(cases, "gb"), { recursive: true })
		mkdirSync(join(cases, "generalization"), { recursive: true })

		writeFileSync(
			join(cases, "gb", "regression.jsonl"),
			[
				JSON.stringify({ id: "a", country: "GB", status: "pass" }),
				JSON.stringify({ id: "b", country: "GB", status: "improvement_target" }),
				JSON.stringify({ id: "c", country: "IE", status: "pass" }),
			].join("\n") + "\n"
		)

		// The loader's /^[a-z]{2}$/ filter excludes this directory. A glob would include it and overstate the board.
		writeFileSync(
			join(cases, "generalization", "passes.jsonl"),
			JSON.stringify({ id: "z", country: "ZZ", status: "pass" }) + "\n"
		)
	})

	it("counts GATED rows apart from tracked ones", () => {
		// A country whose rows are all `improvement_target` has nothing verified, and reporting its row count as
		// coverage is the mistake this separation exists to prevent.
		const board = readBoardCoverage(join(root, "cases"))

		expect(board.get("GB")).toEqual({ rows: 2, gated: 1 })
	})

	it("attributes a row by its own country field, not its directory", () => {
		// Board rows live in a directory by convention and carry their country explicitly; the two disagree in practice.
		expect(readBoardCoverage(join(root, "cases")).get("IE")).toEqual({ rows: 1, gated: 1 })
	})

	it("skips the generalization directory the loader itself skips", () => {
		expect(readBoardCoverage(join(root, "cases")).has("ZZ")).toBe(false)
	})

	it("returns nothing rather than throwing when the cases tree is absent", () => {
		expect(readBoardCoverage(join(root, "no-cases")).size).toBe(0)
	})
})

/**
 * The corpus is a build artifact, not a fixture, so this leg runs only where one exists.
 */
const CORPUS = String(
	dataRootPath(
		"corpus",
		"versioned",
		"v0.26.0-trailing-region-leftcontext",
		"corpus-v0.26.0-trailing-region-leftcontext",
		"MANIFEST.json"
	)
)

describe.skipIf(!existsSync(CORPUS))("buildCorpusCensus against a real shard", () => {
	it("counts street rows on a shard whose PROJECTION drops the labels column", async () => {
		// `getCursor(["country", "labels"])` returns `{country}` alone on the v0.17.0-era writer's shards — silently,
		// with no error — while the v0.5.0 base returns both. A dropped label column reads as "this country has no
		// street rows", which is indistinguishable from the truth. Before the fallback this shard reported 0; it
		// carries 825,083 street rows out of 831,800.
		const manifest = parseJSONStrict<{ shards: Array<{ split?: string; path: string }> }>(readFileSync(CORPUS, "utf8"))

		const one = manifest.shards.filter((s) => s.split === "train" && s.path.includes("v0.17.0-batch")).slice(0, 1)

		expect(one).toHaveLength(1)

		const scratch = join(mkdtempSync(join(tmpdir(), "mw-census-real-")), "MANIFEST.json")

		writeFileSync(scratch, JSON.stringify({ ...manifest, shards: one }))

		const census = await buildCorpusCensus(scratch)

		expect(census.total).toBeGreaterThan(0)
		expect(census.streetRows["GB"] ?? 0).toBeGreaterThan(0)
	}, 120_000)
})

describe("readConfiguredCorpusVersion", () => {
	function config(body: string): string {
		const path = join(mkdtempSync(join(tmpdir(), "mw-cfg-")), "c.yaml")

		writeFileSync(path, body)

		return path
	}

	it("reads the version out of a versioned corpus_dir", () => {
		// The real shape. This is the half the census never checked: the config names 0.27.0 while a cached census
		// counted 0.26.0, and every row count silently answers about the corpus that was counted.
		const path = config(
			"data:\n  corpus_dir: /data/corpus/versioned/v0.27.0-house-venue-intl/corpus-v0.27.0-house-venue-intl\n"
		)

		expect(readConfiguredCorpusVersion(path)).toBe("0.27.0-house-venue-intl")
	})

	it("returns undefined rather than a guess when the config states no corpus_dir", () => {
		// "Cannot check" is not "they match". Returning a plausible default here would manufacture agreement.
		expect(readConfiguredCorpusVersion(config("data:\n  max_length: 128\n"))).toBeUndefined()
		expect(readConfiguredCorpusVersion("/nonexistent-config.yaml")).toBeUndefined()
	})

	it("falls back to the trailing directory when the path is not /versioned/-shaped", () => {
		expect(readConfiguredCorpusVersion(config("data:\n  corpus_dir: /data/corpus/corpus-v0.5.0\n"))).toBe("0.5.0")
	})
})

describe("readAdmittedCountries — the Norway shape", () => {
	it("keeps a QUOTED NO as the string it is, and counts it", () => {
		// A YAML parser turns a bare `NO` key into boolean false, which is the bug this reader exists to avoid
		// reproducing. A quoted "NO" must still be counted — a regex requiring a bare key silently drops Norway and
		// reports it as never admitted.
		const path = join(mkdtempSync(join(tmpdir(), "mw-cfg-no-")), "c.yaml")

		writeFileSync(path, 'data:\n  country_weights:\n    US: 1.0\n    "NO": 1.0\n    FR: 1.0\n')

		const admitted = readAdmittedCountries(path)

		expect(admitted.has("NO")).toBe(true)
		expect(admitted.size).toBe(3)
	})

	it("does not admit a country at weight zero — that is a hard drop, not a low weight", () => {
		const path = join(mkdtempSync(join(tmpdir(), "mw-cfg-zero-")), "c.yaml")

		writeFileSync(path, "data:\n  country_weights:\n    US: 1.0\n    PE: 0\n")

		expect(readAdmittedCountries(path).has("PE")).toBe(false)
	})
})
