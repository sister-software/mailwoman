import type { AddressNode, AddressTree } from "@mailwoman/core/decoder"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { makeDirectories, writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { sha256File } from "@mailwoman/core/hash"
import { openDuckDB } from "@mailwoman/corpus/parquet/duckdb"
import { afterAll, describe, expect, it } from "vitest"

import {
	assertPairedArms,
	countHeldoutCells,
	HELDOUT_CAPABILITY_CELL,
	type HeldoutClassifier,
	type HeldoutRow,
	heldoutRowGroup,
	heldoutRowID,
	heldoutWeightsLocale,
	readHeldoutLocalePackages,
	sampleHeldoutRows,
	scoreHeldoutArm,
	scoreHeldoutWeights,
} from "#tools/eval-harness/heldout/per/country"
import { CURRENT_RELEASE_SPEC } from "#tools/eval-harness/release/current-spec"
import { capabilityProbeSources, readReleaseSpec } from "#tools/eval-harness/release/requirements"

const directory = await temporaryDirectory("mw-heldout-country-")

afterAll(() => directory[Symbol.asyncDispose]())

/**
 * Writes a small test-split parquet file and a corpus manifest naming it under `/data`.
 */
async function writeFixtureCorpus(name: string, valuesSQL: string, columns: string): Promise<string> {
	const file = directory.path(name, "test", "part-0.parquet").toString()
	const manifest = directory.path(name, "MANIFEST.json").toString()

	await writeLocalJSONFile({ slices: [{ path: `/data/${name}/test/part-0.parquet`, split: "test" }] }, manifest)

	await makeDirectories(directory.path(name, "test"))

	using db = await openDuckDB()

	await db.run(`COPY (SELECT * FROM (VALUES ${valuesSQL}) t(${columns})) TO '${file}' (FORMAT parquet)`)

	return manifest
}

describe("heldoutRowGroup", () => {
	it("keys a derived row by its base row and a base row by its own id", () => {
		expect(heldoutRowGroup({ source_id: "oa:1", base_source_id: null }, "r")).toBe("oa:1")
		expect(heldoutRowGroup({ source_id: "oa:1~case", base_source_id: "oa:1" }, "r")).toBe("oa:1")
	})

	it("refuses a row whose grouping columns are unreadable", () => {
		expect(() => heldoutRowGroup({ source_id: null, base_source_id: null }, "r")).toThrow(/no readable grouping/u)
		expect(() => heldoutRowGroup({ source_id: "x", base_source_id: "" }, "r")).toThrow(/unreadable base_source_id/u)
		expect(() => heldoutRowGroup({ source_id: 7, base_source_id: undefined }, "r")).toThrow(/no readable grouping/u)
	})
})

describe("sampleHeldoutRows grouping", () => {
	const spans = "[0], [4], ['street']"
	const columns = "raw, span_starts, span_ends, span_tags, country, source, source_id, base_source_id"

	it("gives a base row and its derived variants one group", async () => {
		const manifest = await writeFixtureCorpus(
			"grouped",
			[
				`('Main', ${spans}, 'US', 'oa-us', 'b1', NULL)`,
				`('main', ${spans}, 'US', 'oa-us', 'b1~lower', 'b1')`,
				`('MAIN', ${spans}, 'US', 'oa-us', 'b1~upper', 'b1')`,
				`('Elms', ${spans}, 'US', 'oa-us', 'b2', NULL)`,
			].join(", "),
			columns
		)

		const { rows, rule } = await sampleHeldoutRows(manifest, 10, directory.path.toString(), 7)
		const groups = new Map(rows.map((row) => [row.source_id, row.group]))

		expect(groups).toEqual(
			new Map([
				["b1", "b1"],
				["b1~lower", "b1"],
				["b1~upper", "b1"],
				["b2", "b2"],
			])
		)

		expect(rule).toMatchObject({ perCountry: 10, seed: 7 })

		const arm = await scoreHeldoutArm(rows, async (row) => ({
			raw: row.raw,
			roots: [],
		}))

		expect(new Set(arm.rows.filter((r) => r.group === "b1").map((r) => r.rowID)).size).toBe(3)
	})

	it("reads one row per record when a record repeats, and counts it once", async () => {
		const manifest = await writeFixtureCorpus(
			"repeated",
			[
				`('Main', ${spans}, 'US', 'oa-us', 'r1', NULL)`,
				`('Main', ${spans}, 'US', 'oa-us', 'r1', NULL)`,
				`('Main St', [0], [7], ['street'], 'US', 'oa-us', 'r1', NULL)`,
				`('Elms', ${spans}, 'US', 'oa-us', 'r2', NULL)`,
			].join(", "),
			columns
		)

		const { rows, counts } = await sampleHeldoutRows(manifest, 10, directory.path.toString(), 7)

		expect(rows.map((row) => row.source_id).toSorted()).toEqual(["r1", "r2"])
		expect(counts).toEqual([{ country: "US", kind: "address", available: 2, sampled: 2 }])
	})

	it("reads only an attribute-split file's test ids and never draws an excluded group", async () => {
		const manifest = await writeFixtureCorpus(
			"attributed",
			[
				`('Main', ${spans}, 'US', 'oa-us', 'a1', NULL)`,
				`('main', ${spans}, 'US', 'oa-us', 'a1~lower', 'a1')`,
				`('Elms', ${spans}, 'US', 'oa-us', 'a2', NULL)`,
				`('Oak', ${spans}, 'US', 'oa-us', 'a3', NULL)`,
			].join(", "),
			columns
		)

		const attribute = directory.path("attributed", "part.split.json").toString()

		await writeLocalJSONFile({ attribute: "split", val: ["a3"], test: ["a1", "a1~lower", "a2"] }, attribute)

		await writeLocalJSONFile(
			{
				slices: [
					{
						path: "/data/attributed/test/part-0.parquet",
						split_attribute: { path: "/data/attributed/part.split.json", sha256: await sha256File(attribute) },
					},
				],
			},
			manifest
		)

		const all = await sampleHeldoutRows(manifest, 10, directory.path.toString(), 7)

		expect(all.rows.map((row) => row.source_id).toSorted()).toEqual(["a1", "a1~lower", "a2"])

		const rest = await sampleHeldoutRows(
			manifest,
			10,
			directory.path.toString(),
			7,
			{},
			{
				datasetID: "dev",
				version: "v",
				groups: ["a1"],
			}
		)

		expect(rest.rows.map((row) => row.source_id)).toEqual(["a2"])
		expect(rest.rule.excludes).toEqual({ datasetID: "dev", version: "v" })
	})

	it("refuses a file that lacks the base_source_id column", async () => {
		const manifest = await writeFixtureCorpus(
			"ungrouped",
			`('Main', ${spans}, 'US', 'oa-us', 'b1')`,
			"raw, span_starts, span_ends, span_tags, country, source, source_id"
		)

		await expect(sampleHeldoutRows(manifest, 10, directory.path.toString())).rejects.toThrow(/base_source_id/u)
	})

	it("refuses a sampled row whose grouping columns are both null", async () => {
		const manifest = await writeFixtureCorpus(
			"null-group",
			`('Main', ${spans}, 'US', 'oa-us', NULL::VARCHAR, NULL::VARCHAR)`,
			columns
		)

		await expect(sampleHeldoutRows(manifest, 10, directory.path.toString())).rejects.toThrow(/no readable grouping/u)
	})
})

const node = (raw: string, tag: AddressNode["tag"], start: number, end: number): AddressNode => ({
	tag,
	value: raw.slice(start, end),
	start,
	end,
	confidence: 1,
	children: [],
})

const rows: HeldoutRow[] = [
	{
		raw: "12 Main St",
		span_starts: [0, 3],
		span_ends: [2, 10],
		span_tags: ["house_number", "street"],
		country: "US",
		source: "oa-us",
		source_id: "a1",
		group: "a1",
	},
	{
		raw: "Wollin, Mecklenburg-Vorpommern",
		span_starts: [0, 8],
		span_ends: [6, 30],
		span_tags: ["locality", "region"],
		country: "DE",
		source: "wof-de",
		source_id: null,
		group: "wof-place-1",
	},
]

const exactTree = (row: HeldoutRow): AddressTree => ({
	raw: row.raw,
	roots: row.span_tags.map((tag, i) =>
		node(row.raw, tag as AddressNode["tag"], row.span_starts[i]!, row.span_ends[i]!)
	),
})

const extraTree = (row: HeldoutRow): AddressTree => {
	const tree = exactTree(row)

	return { ...tree, roots: [...tree.roots, node(row.raw, "postcode", 0, 2)] }
}

describe("scoreHeldoutArm", () => {
	it("writes aligned per-row outcomes for two arms on identical rows", async () => {
		const shipped = await scoreHeldoutArm(rows, async (row) => exactTree(row))
		const candidate = await scoreHeldoutArm(rows, async (row) => extraTree(row))

		expect(() => assertPairedArms([shipped, candidate])).not.toThrow()
		expect(shipped.rows.map((r) => r.rowID)).toEqual(["oa-us:a1", heldoutRowID(rows[1]!)])
		expect(heldoutRowID(rows[1]!)).toMatch(/^wof-de:raw-sha256:[0-9a-f]{64}$/u)

		expect(shipped.rows.map((r) => [r.country, r.kind, r.exact, r.provenance])).toEqual([
			["US", "address", true, "unknown"],
			["DE", "gazetteer", true, "unknown"],
		])

		// The additional span fails exact parsing but leaves every gold span recovered.
		expect(candidate.rows[0]).toMatchObject({
			exact: false,
			additionalSpans: 1,
			goldRecovered: true,
		})

		expect(candidate.cells.get("US/address")).toEqual({
			rows: 1,
			rowsExactParse: 0,
			rowsStreetJoinChanged: 0,
			rowsGoldRecovered: 1,
			spans: 2,
			spansRecovered: 2,
		})
	})

	it("totals a capability probe's rows in the country's capability cell, not its address cell", async () => {
		const spec = await readReleaseSpec(CURRENT_RELEASE_SPEC)
		const probes = capabilityProbeSources(spec)
		const [probe] = [...probes]
		const probeRow: HeldoutRow = { ...rows[0]!, source: probe!, source_id: "p1", group: "p1" }
		const arm = await scoreHeldoutArm([rows[0]!, probeRow], async (row) => exactTree(row), undefined, undefined, probes)

		expect(arm.rows.map((r) => [r.source, r.kind])).toEqual([
			["oa-us", "address"],
			[probe, "address"],
		])
		expect(arm.cells.get("US/address")?.rows).toBe(1)
		expect(arm.cells.get(`US/${HELDOUT_CAPABILITY_CELL}`)?.rows).toBe(1)
	})

	it("assigns a provenance class only from a recorded history", async () => {
		const history = new Map([["oa-us:a1", { provenance: "verified_unseen" as const, evidence: "audit.json#sha" }]])
		const arm = await scoreHeldoutArm(rows, async (row) => exactTree(row), history)

		expect(arm.rows.map((r) => r.provenance)).toEqual(["verified_unseen", "unknown"])
	})

	it("refuses misaligned arms and duplicate identities", async () => {
		const full = await scoreHeldoutArm(rows, async (row) => exactTree(row))
		const reversed = await scoreHeldoutArm(rows.toReversed(), async (row) => exactTree(row))

		expect(() => assertPairedArms([full, reversed])).toThrow(/row 0/u)
		await expect(scoreHeldoutArm([rows[0]!, rows[0]!], async (row) => exactTree(row))).rejects.toThrow(/share/u)
	})

	it("refuses a malformed annotation rather than scoring it", async () => {
		const bad = { ...rows[0]!, span_ends: [2] }

		await expect(scoreHeldoutArm([bad], async () => exactTree(rows[0]!))).rejects.toThrow(/row oa-us:a1/u)
	})
})

describe("scoreHeldoutWeights", () => {
	const packages = new Map([
		["US", "en-us"],
		["DE", "de-de"],
	])

	it("parses each row with its country's shipped package, falling back to en-us, and records it", async () => {
		const loaded: string[] = []
		const rowsWithFallback: HeldoutRow[] = [...rows, { ...rows[0]!, country: "UY", source_id: "u1", group: "u1" }]

		const arm = await scoreHeldoutWeights(rowsWithFallback, "/cache", undefined, {
			packages,
			load: async (locale, cacheRoot) => {
				loaded.push(`${locale}@${cacheRoot}`)

				const classifier: HeldoutClassifier = {
					unfedChannels: [],
					parse: async (raw: string) => exactTree(rowsWithFallback.find((r) => r.raw === raw)!),
				}

				return classifier
			},
		})

		expect(arm.rows.map((r) => [r.country, r.weightsLocale])).toEqual([
			["US", "en-us"],
			["DE", "de-de"],
			["UY", "en-us"],
		])

		expect(loaded).toEqual(["en-us@/cache", "de-de@/cache"])
		expect(heldoutWeightsLocale(null, packages)).toBe("en-us")
		expect(heldoutWeightsLocale("de", packages)).toBe("de-de")
	})

	it("refuses a package whose loader reports an unfed required channel", async () => {
		const unfedChannels: HeldoutClassifier["unfedChannels"] = [
			{
				channel: "anchor",
				weightsPackage: "/cache/node_modules/@mailwoman/neural-weights-en-us",
				detail: "postcode-us.bin is NOT in the package",
			},
		]

		await expect(
			scoreHeldoutWeights(rows, "/cache", undefined, {
				packages,
				load: async () => ({ unfedChannels, parse: async () => exactTree(rows[0]!) }),
			})
		).rejects.toThrow(
			/required anchor channel unfed for \/cache\/node_modules\/@mailwoman\/neural-weights-en-us \(postcode-us\.bin/u
		)
	})

	it("reads the shipped Latin locales from release.config.json", async () => {
		const shipped = await readHeldoutLocalePackages()

		expect(shipped.get("US")).toBe("en-us")
		expect(shipped.get("GB")).toBe("en-gb")
		expect([...shipped.values()].every((locale) => /^[a-z]{2}-[a-z]{2}$/u.test(locale))).toBe(true)
	})
})

describe("countHeldoutCells", () => {
	it("reports available and sampled rows per country and kind", () => {
		expect(
			countHeldoutCells(
				[
					{ country: "US", kind: "address", available: 900 },
					{ country: "DE", kind: "gazetteer", available: 40 },
					{ country: "DE", kind: "address", available: 3 },
				],
				rows
			)
		).toEqual([
			{ country: "DE", kind: "address", available: 3, sampled: 0 },
			{ country: "DE", kind: "gazetteer", available: 40, sampled: 1 },
			{ country: "US", kind: "address", available: 900, sampled: 1 },
		])
	})

	it("refuses a sampled row outside the availability count", () => {
		expect(() => countHeldoutCells([], rows)).toThrow(/lacks/u)
	})
})
