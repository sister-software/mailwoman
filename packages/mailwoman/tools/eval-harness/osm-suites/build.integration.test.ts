/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The OpenStreetMap suites built from two small extracts, filtered against a training corpus that holds one
 *   of their rows, with each suite's lineage recording the PBF digest, the policy and the filter.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { makeDirectories, writeLocalJSONFile, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/json"
import { openDuckDB } from "@mailwoman/corpus/parquet/duckdb"
import { extractionPolicyFor, extractionPolicyName } from "@mailwoman/osm/extraction-policy"
import { afterAll, describe, expect, it } from "vitest"

import { readHeldoutDatasetRows } from "#tools/eval-harness/heldout/dataset/manifest"
import { collectOSMSuiteRows, freezeOSMSuites } from "#tools/eval-harness/osm-suites/build"
import { countExtractLines, type OSMSuiteRow, renderOSMExtractRecord } from "#tools/eval-harness/osm-suites/extract"
import { OSMSuiteShape } from "#tools/eval-harness/osm-suites/shapes"

const directory = await temporaryDirectory("mw-osm-suites-")
const root = directory.path.toString()

afterAll(() => directory[Symbol.asyncDispose]())

const PK_ROWS = [
	{ number: "12", place: "DHA Phase 6", city: "Karachi" },
	{ number: "4", place: "Gulshan e Iqbal Block 2", city: "Karachi" },
	{ street: "Jinnah Avenue", number: "5", city: "Islamabad" },
]

const US_ROWS = [
	{ street: "Main Street", number: "302", unit: "STE 302", city: "Springfield", province: "IL", postcode: "62701" },
	{ street: "Oak Street", number: "9", city: "Springfield", province: "IL", postcode: "62702" },
	{ street: "Elm Street", number: "1", country: "CA" },
]

async function writeExtract(country: string, rows: readonly object[]): Promise<string> {
	const path = `${root}/extracts/osm-${country}-261016.corpus.jsonl`
	const pbf = `${root}/geofabrik/${country}-261016.osm.pbf`

	await writeLocalTextFile(rows.map((row) => `${stringifyJSON(row)}\n`).join(""), path)

	await writeLocalJSONFile(
		{
			source_url: `https://download.geofabrik.de/${country}-latest.osm.pbf`,
			sha256: country.repeat(32),
			last_modified: "Fri, 16 Oct 2026 21:00:00 GMT",
		},
		`${pbf}.receipt.json`
	)

	await writeLocalJSONFile(
		{
			pbf,
			receipt: `${pbf}.receipt.json`,
			outline: null,
			excluded_outlines: [],
			locality_levels: [],
			dependent_locality_levels: [],
		},
		`${path}.stats.json`
	)

	return path
}

/**
 * A training corpus whose one train file holds the row `trainedID`, and the model card that names it.
 */
async function writeTraining(trainedID: string): Promise<{ manifest: string; card: string }> {
	const file = `${root}/corpus/train/part-0.parquet`

	await makeDirectories(`${root}/corpus/train`)

	using db = await openDuckDB()

	await db.run(
		`COPY (SELECT * FROM (VALUES ('osm', '${trainedID}', NULL::VARCHAR)) t(source, source_id, base_source_id)) ` +
			`TO '${file}' (FORMAT parquet)`
	)

	const manifest = `${root}/corpus/MANIFEST.json`
	const card = `${root}/cards/published.json`

	await writeLocalJSONFile(
		{ corpus_version: "v-fixture", files: [{ path: "/data/corpus/train/part-0.parquet", split: "train", rows: 1 }] },
		manifest
	)

	await writeLocalJSONFile({ training: { corpus_version: "v-fixture" } }, card)

	return { manifest, card }
}

describe("the OpenStreetMap suites", () => {
	it("samples each shape, drops the row a compared model trained on, and records lineage", async () => {
		const pk = await writeExtract("pk", PK_ROWS)
		const us = await writeExtract("us", US_ROWS)

		expect(await countExtractLines(pk)).toBe(3)

		const trained = renderOSMExtractRecord(PK_ROWS[0]!, "PK", {})!
		const training = await writeTraining(trained.source_id!)
		const collected = await collectOSMSuiteRows({ files: [pk, us], perCountry: 10, seed: 1 })

		expect(
			collected.map((file) => [file.country, file.tally["read"], file.tally["row:country-tag-mismatch"] ?? 0])
		).toEqual([
			["PK", 3, 0],
			["US", 3, 1],
		])

		const frozen = await freezeOSMSuites({
			collected,
			perCountry: 10,
			seed: 1,
			overlap: { corpora: [training.manifest], modelCards: [training.card], pathRoot: root },
			outDirectory: `${root}/out`,
			createdAt: "2026-10-29T00:00:00Z",
			policyFor: (country) => {
				const policy = extractionPolicyFor(country)

				return policy ? { name: extractionPolicyName(policy), version: policy.version } : null
			},
		})

		const byShape = Object.fromEntries(frozen.map((suite) => [suite.shape, suite]))

		// Both Karachi rows are numbered within a place, and the first is in the training corpus.
		expect(byShape[OSMSuiteShape.PlaceWithoutStreet]).toMatchObject({ sampled: 2, kept: 1 })
		expect(byShape[OSMSuiteShape.Unit]).toMatchObject({ sampled: 1, kept: 1 })
		expect(byShape[OSMSuiteShape.RegionAfterLocality]).toMatchObject({ sampled: 2, kept: 2 })

		const { rows } = await readHeldoutDatasetRows(byShape[OSMSuiteShape.PlaceWithoutStreet]!.manifestPath)

		expect(rows.map((row) => row.raw)).toEqual(["4, Gulshan e Iqbal Block 2, Karachi"])
		// The mapped tags stay apart from the rendered components.
		expect((rows[0] as OSMSuiteRow).mapped).toEqual(PK_ROWS[1])

		const lineage = await readLocalJSONFile<{
			filter: string
			policies: Record<string, unknown>
			extracts: Array<{ pbf: { sha256: string }; extract: { lines: number } }>
			overlap: {
				auditSHA256: string
				counts: Record<string, number>
				audit: { counts: Record<string, number> }
			}
		}>(byShape[OSMSuiteShape.PlaceWithoutStreet]!.lineagePath)

		expect(lineage.filter).toBe("a house_number span and no street span")
		expect(lineage.policies).toEqual({ PK: { name: "osm/pk/extraction-policy", version: 1 }, US: null })

		expect(lineage.extracts.map((extract) => [extract.pbf.sha256, extract.extract.lines])).toEqual([
			["pk".repeat(32), 3],
			["us".repeat(32), 3],
		])

		expect(lineage.overlap.counts).toMatchObject({ known_overlap: 1, verified_unseen: 1 })
		// One audit classed every suite's rows: the two Karachi rows and the two Springfield rows, each once.
		expect(Object.values(lineage.overlap.audit.counts).reduce((sum, n) => sum + n, 0)).toBe(4)
		expect(lineage.overlap.auditSHA256).toMatch(/^[0-9a-f]{64}$/u)
	})

	it("keeps one row for an address two extracts render alike, and counts the other", async () => {
		const first = await writeExtract("pk", PK_ROWS)
		const second = `${root}/extracts/osm-pk-261017.corpus.jsonl`

		await writeLocalTextFile(`${stringifyJSON(PK_ROWS[1])}\n`, second)
		await writeLocalJSONFile({ outline: null }, `${second}.stats.json`)

		const training = await writeTraining("nothing-matches")
		const collected = await collectOSMSuiteRows({ files: [first, second], perCountry: 10, seed: 1 })

		const frozen = await freezeOSMSuites({
			collected,
			perCountry: 10,
			seed: 1,
			overlap: { corpora: [training.manifest], modelCards: [training.card], pathRoot: root },
			outDirectory: `${root}/out-duplicates`,
			createdAt: "2026-10-29T00:00:00Z",
			policyFor: () => null,
		})

		const suite = frozen.find((candidate) => candidate.shape === OSMSuiteShape.PlaceWithoutStreet)!
		const lineage = await readLocalJSONFile<{ crossCountryDuplicates: number }>(suite.lineagePath)

		expect(suite).toMatchObject({ sampled: 2, kept: 2 })
		expect(lineage.crossCountryDuplicates).toBe(1)
	})

	it("keeps no row when a model card's training corpus was not read", async () => {
		const pk = await writeExtract("pk", PK_ROWS)
		const card = `${root}/cards/unread.json`

		await writeLocalJSONFile({ training: { corpus_version: "v-unread" } }, card)

		const training = await writeTraining("nothing-matches")
		const collected = await collectOSMSuiteRows({ files: [pk], perCountry: 10, seed: 1 })

		const frozen = await freezeOSMSuites({
			collected,
			perCountry: 10,
			seed: 1,
			overlap: { corpora: [training.manifest], modelCards: [training.card, card], pathRoot: root },
			outDirectory: `${root}/out-unread`,
			createdAt: "2026-10-29T00:00:00Z",
			policyFor: () => null,
		})

		const suite = frozen.find((candidate) => candidate.shape === OSMSuiteShape.PlaceWithoutStreet)!

		expect(suite).toMatchObject({ sampled: 2, kept: 0 })
		expect(suite.audit.reasons).toEqual([expect.stringContaining("v-unread is not among the corpora read")])
	})
})
