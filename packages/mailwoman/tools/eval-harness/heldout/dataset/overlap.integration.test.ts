// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { makeDirectories, writeLocalJSONFile, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { sha256File } from "@mailwoman/core/hash"
import { openDuckDB } from "@mailwoman/corpus/parquet/duckdb"
import { writeParquetFile } from "@mailwoman/corpus/parquet/writers"
import { gbOverlayRow } from "@mailwoman/corpus/test-kit"
import { splitOverlaySlice } from "@mailwoman/corpus/tools/overlay/split/overlay"
import {
	buildEvaluationGroupsFile,
	evaluationGroupsIdentity,
	readEvaluationGroups,
} from "@mailwoman/corpus/utils/evaluation-groups"
import {
	evaluationGroupPolicy,
	readValidationGroups,
	selectValidationGroups,
	VALIDATION_GROUPS_ATTRIBUTE,
	validationTarget,
} from "@mailwoman/corpus/utils/validation-groups"
import { afterAll, describe, expect, it } from "vitest"

import { readValidationPool } from "#tools/dev-tools/corpus/validation/quota"
import { buildHeldoutDatasetManifest } from "#tools/eval-harness/heldout/dataset/manifest"
import { auditHeldoutOverlap } from "#tools/eval-harness/heldout/dataset/overlap"
import type { HeldoutRow } from "#tools/eval-harness/heldout/per/country"

const directory = await temporaryDirectory("mw-heldout-overlap-")
const root = directory.path.toString()

afterAll(() => directory[Symbol.asyncDispose]())

const evalRow = (sourceID: string, group = sourceID): HeldoutRow => ({
	raw: `${sourceID} Main St`,
	span_starts: [0],
	span_ends: [sourceID.length],
	span_tags: ["house_number"],
	country: "US",
	source: "oa-us",
	source_id: sourceID,
	group,
})

const datasetInput = {
	datasetID: "heldout-fixture",
	createdAt: "2026-10-20T00:00:00.000Z",
	drawnFrom: {
		manifest: "/data/eval/MANIFEST.json",
		sha256: "a".repeat(64),
		corpusVersion: "v-eval",
		files: [],
	},
	sampling: {
		method: "per-record-id-country-kind-hash-order",
		perCountry: 10,
		seed: null,
		order: "hash(raw)",
		engine: "duckdb",
	},
	cells: [{ country: "US", kind: "address", available: 4, sampled: 4 }],
	rows: [evalRow("same"), evalRow("variant-base"), evalRow("held-only"), evalRow("fresh")],
	rowsFilePath: "fixture.rows.jsonl",
} satisfies Parameters<typeof buildHeldoutDatasetManifest>[0]

const dataset = buildHeldoutDatasetManifest(datasetInput)

/**
 * Writes one parquet file of `(source, source_id, base_source_id)` rows and returns its row count.
 */
async function writeIDs(relative: string, rows: Array<[string, string, string | null]>): Promise<number> {
	const file = `${root}/${relative}`

	await makeDirectories(file.slice(0, file.lastIndexOf("/")))

	using db = await openDuckDB()

	const values = rows
		.map(([source, id, base]) => `('${source}', '${id}', ${base == null ? "NULL::VARCHAR" : `'${base}'`})`)
		.join(", ")

	await db.run(
		`COPY (SELECT * FROM (VALUES ${values}) t(source, source_id, base_source_id)) TO '${file}' (FORMAT parquet)`
	)

	return rows.length
}

async function writeCorpus(name: string, corpusVersion: string | null, trainRowsDelta = 0): Promise<string> {
	const trainRows = await writeIDs(`${name}/train/part-0.parquet`, [
		["oa-us", "same", null],
		["oa-us", "variant-base~typo", "variant-base"],
		["oa-us", "unrelated", null],
	])

	const valRows = await writeIDs(`${name}/val/part-0.parquet`, [["oa-us", "other", null]])
	const testRows = await writeIDs(`${name}/test/part-0.parquet`, [["oa-us", "held-only", null]])
	const manifest = `${root}/${name}/MANIFEST.json`

	await writeLocalJSONFile(
		{
			...(corpusVersion ? { corpus_version: corpusVersion } : {}),
			files: [
				{
					path: `/data/${name}/train/part-0.parquet`,
					split: "train",
					rows: trainRows + trainRowsDelta,
					sha256: "t",
				},
				{
					path: `/data/${name}/val/part-0.parquet`,
					split: "val",
					rows: valRows,
					sha256: "v",
				},
				{
					path: `/data/${name}/test/part-0.parquet`,
					split: "test",
					rows: testRows,
					sha256: "s",
				},
			],
		},
		manifest
	)

	return manifest
}

async function writeCard(name: string, corpusVersion: string): Promise<string> {
	const path = `${root}/cards/${name}.json`

	await writeLocalJSONFile({ training: { corpus_version: corpusVersion } }, path)

	return path
}

describe("auditHeldoutOverlap", () => {
	it("classes identity and group matches as known_overlap and the rest as verified_unseen", async () => {
		const corpus = await writeCorpus("published", "v-published")
		const card = await writeCard("published", "v-published")

		const result = await auditHeldoutOverlap({
			dataset,
			corpora: [corpus],
			modelCards: [card],
			pathRoot: root,
		})

		expect(result.audit.verifiedUnseenAdmitted).toBe(true)

		expect(result.audit.counts).toEqual({
			verified_unseen: 2,
			unseen_by_candidate: 0,
			known_overlap: 2,
			unknown: 0,
		})

		expect(result.rows["oa-us:same"]).toMatchObject({
			provenance: "known_overlap",
		})

		expect(result.rows["oa-us:same"]!.evidence).toMatch(/identity oa-us:same in v-published train/u)
		expect(result.rows["oa-us:variant-base"]!.evidence).toMatch(/group variant-base/u)

		// A row present only in the training corpus's test split isn't training data.
		expect(result.rows["oa-us:held-only"]).toMatchObject({
			provenance: "verified_unseen",
		})

		expect(result.unknown).toEqual([])

		expect(result.audit.corpora[0]!.files.map((file) => [file.split, file.read])).toEqual([
			["train", true],
			["val", true],
			["test", false],
		])
	})

	it("matches a card's v-prefixed corpus key to a manifest's bare corpus_version", async () => {
		const corpus = await writeCorpus("prefixed", "0.9.1")
		const card = await writeCard("prefixed", "v0.9.1")

		const result = await auditHeldoutOverlap({ dataset, corpora: [corpus], modelCards: [card], pathRoot: root })

		expect(result.audit.modelCards[0]).toMatchObject({ matched: true, problem: null })
	})

	it("refuses verified_unseen when a model card's corpus is not among those read", async () => {
		const corpus = await writeCorpus("candidate", "v-candidate")
		const read = await writeCard("candidate", "v-candidate")
		const unread = await writeCard("published-elsewhere", "v-never-read")

		const result = await auditHeldoutOverlap({
			dataset,
			corpora: [corpus],
			modelCards: [read, unread],
			pathRoot: root,
		})

		expect(result.audit.verifiedUnseenAdmitted).toBe(false)
		expect(result.audit.reasons.join("\n")).toMatch(/v-never-read is not among the corpora read/u)

		expect(result.audit.counts).toEqual({
			verified_unseen: 0,
			unseen_by_candidate: 0,
			known_overlap: 2,
			unknown: 2,
		})

		expect(result.unknown.toSorted()).toEqual(["oa-us:fresh", "oa-us:held-only"])
		expect(Object.values(result.rows).every((record) => record.provenance === "known_overlap")).toBe(true)
	})

	it("classes rows absent from the candidate's corpus unseen_by_candidate, even where the published model trained on them", async () => {
		const published = await writeCorpus("ubc-published", "v-ubc-published")
		const publishedCard = await writeCard("ubc-published", "v-ubc-published")
		const candidateCorpus = `${root}/ubc-candidate/MANIFEST.json`
		const trainRows = await writeIDs("ubc-candidate/train/part-0.parquet", [["oa-us", "variant-base", null]])

		await writeLocalJSONFile(
			{
				corpus_version: "v-ubc-candidate",
				files: [{ path: "/data/ubc-candidate/train/part-0.parquet", split: "train", rows: trainRows, sha256: "t" }],
			},
			candidateCorpus
		)

		const candidateCard = await writeCard("ubc-candidate", "v-ubc-candidate")

		const result = await auditHeldoutOverlap({
			dataset,
			corpora: [published, candidateCorpus],
			modelCards: [publishedCard, candidateCard],
			candidateModelCard: candidateCard,
			pathRoot: root,
		})

		expect(result.audit.counts).toEqual({
			verified_unseen: 2,
			unseen_by_candidate: 1,
			known_overlap: 1,
			unknown: 0,
		})

		// "same" is in the published corpus only; "variant-base" is in the candidate's.
		expect(result.rows["oa-us:same"]).toMatchObject({ provenance: "unseen_by_candidate" })

		expect(result.rows["oa-us:same"]!.evidence).toMatch(
			/absent from the candidate's v-ubc-candidate.*identity oa-us:same in v-ubc-published/u
		)

		expect(result.rows["oa-us:variant-base"]).toMatchObject({ provenance: "known_overlap" })
	})

	it("classes unseen_by_candidate rows when only the published model's history is unestablished", async () => {
		const corpus = await writeCorpus("ubc-only", "v-ubc-only")
		const candidateCard = await writeCard("ubc-only", "v-ubc-only")
		const unread = await writeCard("ubc-unread", "v-ubc-never-read")

		const result = await auditHeldoutOverlap({
			dataset,
			corpora: [corpus],
			modelCards: [unread, candidateCard],
			candidateModelCard: candidateCard,
			pathRoot: root,
		})

		expect(result.audit.verifiedUnseenAdmitted).toBe(false)
		expect(result.audit.counts).toEqual({ verified_unseen: 0, unseen_by_candidate: 2, known_overlap: 2, unknown: 0 })
		expect(result.rows["oa-us:fresh"]!.evidence).toMatch(/published model's history is not established/u)

		const swapped = await auditHeldoutOverlap({
			dataset,
			corpora: [corpus],
			modelCards: [unread, candidateCard],
			candidateModelCard: unread,
			pathRoot: root,
		})

		// A candidate card whose corpus was left unread leaves the candidate's history unestablished.
		expect(swapped.audit.counts).toEqual({ verified_unseen: 0, unseen_by_candidate: 0, known_overlap: 2, unknown: 2 })

		await expect(
			auditHeldoutOverlap({
				dataset,
				corpora: [corpus],
				modelCards: [unread],
				candidateModelCard: candidateCard,
				pathRoot: root,
			})
		).rejects.toThrow(/not among the model cards or training configs named/u)
	})

	it("reads a model's corpus from its training config's data.corpus_dir, held to a card's rules", async () => {
		const corpus = await writeCorpus("from-config", "0.9.2-config")
		const published = await writeCard("from-config-published", "v0.9.2-config")
		const config = `${root}/configs/arm.yaml`
		const ancestor = `${root}/configs/fine-tune.yaml`

		await writeLocalTextFile("data:\n  corpus_dir: /data/corpus/versioned/v0.9.2-config/corpus-v0.9.2-config\n", config)

		await writeLocalTextFile(
			"data:\n  corpus_dir: /data/corpus/versioned/v0.9.2-config/corpus-v0.9.2-config\n" +
				"train:\n  init_from: /data/models/primer/best.pt\n",
			ancestor
		)

		const result = await auditHeldoutOverlap({
			dataset,
			corpora: [corpus],
			modelCards: [published],
			trainingConfigs: [config],
			candidateModelCard: config,
			pathRoot: root,
		})

		expect(result.audit.verifiedUnseenAdmitted).toBe(true)

		expect(result.audit.modelCards).toEqual([
			{ path: published, source: "model-card", corpusVersion: "v0.9.2-config", matched: true, problem: null },
			{ path: config, source: "training-config", corpusVersion: "v0.9.2-config", matched: true, problem: null },
		])

		expect(result.audit.counts).toEqual({ verified_unseen: 2, unseen_by_candidate: 0, known_overlap: 2, unknown: 0 })

		const refused = await auditHeldoutOverlap({
			dataset,
			corpora: [corpus],
			modelCards: [published],
			trainingConfigs: [ancestor],
			pathRoot: root,
		})

		expect(refused.audit.verifiedUnseenAdmitted).toBe(false)

		expect(refused.audit.reasons.join("\n")).toMatch(
			/training config .*fine-tune\.yaml: the config's train\.init_from/u
		)

		expect(refused.audit.counts.verified_unseen).toBe(0)
	})

	it("classes a row whose folded text a training row holds under another source as known_overlap", async () => {
		const file = `${root}/texts/train/part-0.parquet`

		await makeDirectories(`${root}/texts/train`)

		{
			using db = await openDuckDB()

			// Case, accents and punctuation differ from the held-out text `fresh Main St`; a longer text doesn't match.
			await db.run(
				`COPY (SELECT * FROM (VALUES ('other-source', 'x1', NULL::VARCHAR, 'FRÉSH, main st.'), ` +
					`('other-source', 'x2', NULL::VARCHAR, 'held-only Main St, United States')) ` +
					`t(source, source_id, base_source_id, raw)) TO '${file}' (FORMAT parquet)`
			)
		}

		const manifest = `${root}/texts/MANIFEST.json`

		await writeLocalJSONFile(
			{
				corpus_version: "v-texts",
				files: [{ path: "/data/texts/train/part-0.parquet", split: "train", rows: 2, sha256: "t" }],
			},
			manifest
		)

		const card = await writeCard("texts", "v-texts")

		const rowTexts = new Map(
			dataset.rows.map((entry) => [entry.rowID, `${entry.rowID.slice("oa-us:".length)} Main St`])
		)

		const withText = await auditHeldoutOverlap({
			dataset,
			corpora: [manifest],
			modelCards: [card],
			pathRoot: root,
			rowTexts,
		})

		expect(withText.audit.textCompared).toBe(true)
		expect(withText.rows["oa-us:fresh"]).toMatchObject({ provenance: "known_overlap" })

		expect(withText.rows["oa-us:fresh"]!.evidence).toMatch(
			/folded text "fresh main st" \(training row other-source:x1\)/u
		)

		expect(withText.rows["oa-us:held-only"]).toMatchObject({ provenance: "verified_unseen" })

		const withoutText = await auditHeldoutOverlap({ dataset, corpora: [manifest], modelCards: [card], pathRoot: root })

		expect(withoutText.audit.textCompared).toBe(false)
		expect(withoutText.rows["oa-us:fresh"]).toMatchObject({ provenance: "verified_unseen" })

		await expect(
			auditHeldoutOverlap({ dataset, corpora: [manifest], modelCards: [card], pathRoot: root, rowTexts: new Map() })
		).rejects.toThrow(/has no text for the folded-text comparison/u)
	})

	it("refuses verified_unseen when no model card is named", async () => {
		const corpus = await writeCorpus("no-card", "v-no-card")

		const result = await auditHeldoutOverlap({
			dataset,
			corpora: [corpus],
			modelCards: [],
			pathRoot: root,
		})

		expect(result.audit.verifiedUnseenAdmitted).toBe(false)
		expect(result.audit.counts.verified_unseen).toBe(0)
	})

	it("refuses a partial read: a row count that differs from the manifest's record", async () => {
		const corpus = await writeCorpus("short", "v-short", 1)
		const card = await writeCard("short", "v-short")

		await expect(
			auditHeldoutOverlap({
				dataset,
				corpora: [corpus],
				modelCards: [card],
				pathRoot: root,
			})
		).rejects.toThrow(/holds 3 rows; .* records 4; refusing a partial read/u)
	})

	it("finds no frozen group in train or val of a corpus split under the evaluation-group policy", async () => {
		const parquet = `${root}/policy/part-gb.parquet`
		const frozenRows = [gbOverlayRow("gb-f1", "Lemon Street", "Truro", "TR1 2LS")]

		const rows = [
			...frozenRows,
			// A case variant of the frozen base row, and two rendered rows of one frozen record.
			{ ...gbOverlayRow("gb-f1+case-lower", "lemon street", "truro", "tr1 2ls"), base_source_id: "gb-f1" },
			gbOverlayRow("gb-r#a", "Boscawen Street", "Truro", "TR1 2QQ"),
			gbOverlayRow("gb-r#b", "Boscawen St", "Truro", "TR1 2QQ"),
			// Rows of the same held-out place outside the frozen groups, and rows elsewhere.
			...Array.from({ length: 40 }, (_, index) =>
				gbOverlayRow(`gb-p${index}`, `${index} River Street`, "Truro", "TR1 2QE")
			),
			gbOverlayRow("gb-l1", "Hope Street", "Liverpool", "L1 9BP"),
		]

		await makeDirectories(`${root}/policy`)
		await writeParquetFile(rows, parquet, { extractHash: "fixture", codeHash: "fixture", config: {} })

		const frozen = buildHeldoutDatasetManifest({
			...datasetInput,
			datasetID: "heldout-frozen",
			rows: [
				{ ...evalRow("gb-f1"), source: "rendered-gb-os-open", country: "GB" },
				{ ...evalRow("gb-r#a", "gb-r"), source: "rendered-gb-os-open", country: "GB" },
			],
		})

		const groupsFile = `${root}/policy/groups.json`

		await writeLocalJSONFile(
			buildEvaluationGroupsFile({
				drawnFrom: { corpusVersion: "v-policy-base", sha256: "a".repeat(64) },
				datasets: [
					{
						datasetID: frozen.datasetID,
						version: frozen.version,
						manifestSHA256: "b".repeat(64),
						rows: frozen.rows.length,
						groups: frozen.rows.map((entry) => entry.group),
					},
				],
			}),
			groupsFile
		)

		// Writes a one-file corpus manifest for a split of the fixture, with absolute paths.
		const writeManifest = async (name: string, split: { attribute: string }) => {
			const manifest = `${root}/${name}/MANIFEST.json`

			await writeLocalJSONFile(
				{
					corpus_version: `v-${name}`,
					files: [
						{
							path: parquet,
							rows: rows.length,
							sha256: await sha256File(parquet),
							split_attribute: { path: split.attribute, sha256: await sha256File(split.attribute) },
						},
					],
				},
				manifest
			)

			return manifest
		}

		// The holdout policy's split is the pool the quota draws its validation groups from.
		const base = await writeManifest(
			"policy-base",
			await splitOverlaySlice({ input: parquet, outputDir: `${root}/policy-base` })
		)

		const frozenGroups = await readEvaluationGroups(groupsFile)
		const quota = { margin: 2, minimumRows: 5, capRows: 20 }
		const pool = await readValidationPool({ manifest: base, frozen: frozenGroups, capRows: quota.capRows })
		const chosen = selectValidationGroups(pool.candidates, () => validationTarget(undefined, quota), quota)
		const validationFile = `${root}/policy/validation.json`

		await writeLocalJSONFile(
			{
				attribute: VALIDATION_GROUPS_ATTRIBUTE,
				drawnFrom: { manifest: base, sha256: await sha256File(base), corpusVersion: "v-policy-base" },
				config: { path: "fixture.yaml", sha256: "c".repeat(64) },
				evaluationGroups: evaluationGroupsIdentity(frozenGroups),
				quota,
				countries: chosen.countries,
				groups: chosen.groups,
			},
			validationFile
		)

		// The quota takes the lowest-hash held-out groups outside the frozen list, and no frozen group.
		expect(chosen.countries.GB).toMatchObject({ rows: 5, exhausted: false })
		expect(chosen.groups.some((group) => frozenGroups.groups.has(group))).toBe(false)

		const policy = evaluationGroupPolicy(frozenGroups, await readValidationGroups(validationFile))

		const audit = async (name: string, evaluationGroups: typeof policy) => {
			const split = await splitOverlaySlice({ input: parquet, outputDir: `${root}/${name}`, evaluationGroups })
			const manifest = await writeManifest(name, split)
			const card = await writeCard(name, `v-${name}`)

			return {
				split,
				result: await auditHeldoutOverlap({ dataset: frozen, corpora: [manifest], modelCards: [card], pathRoot: root }),
			}
		}

		const held = await audit("policy-held", policy)

		expect(held.split.counts).toEqual({ train: rows.length - 9, val: 5, test: 4 })

		expect(held.result.audit.counts).toEqual({
			verified_unseen: 2,
			unseen_by_candidate: 0,
			known_overlap: 0,
			unknown: 0,
		})

		// The negative control: a frozen list missing one group lets that group's
		// rows reach training, and the audit finds them.
		const leaked = await audit("policy-leaked", {
			...policy,
			frozen: { ...frozenGroups, groups: new Set(["gb-f1"]) },
		})

		expect(leaked.result.audit.counts.known_overlap).toBe(1)
		expect(leaked.result.rows["rendered-gb-os-open:gb-r#a"]).toMatchObject({ provenance: "known_overlap" })
	})

	it("refuses a partial read: a listed file that is missing", async () => {
		const manifest = `${root}/missing/MANIFEST.json`

		await writeLocalJSONFile(
			{
				corpus_version: "v-missing",
				files: [{ path: "/data/missing/train/gone.parquet", split: "train", rows: 1 }],
			},
			manifest
		)

		await expect(
			auditHeldoutOverlap({
				dataset,
				corpora: [manifest],
				modelCards: [],
				pathRoot: root,
			})
		).rejects.toThrow(/is missing; refusing a partial read/u)
	})
})
