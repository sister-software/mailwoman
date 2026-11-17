// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file The evaluation-group policy: a frozen group never trains, and every row outside the frozen and
 *   validation groups does.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { afterAll, describe, expect, it } from "vitest"

import {
	buildEvaluationGroupsFile,
	evaluationGroupOf,
	evaluationGroupsV0818Path,
	evaluationGroupsV0819Path,
	readEvaluationGroups,
} from "#utils/evaluation-groups"
import { defaultHoldouts, splitForRow } from "#utils/split"

const directory = await temporaryDirectory("mw-evaluation-groups-")

afterAll(() => directory[Symbol.asyncDispose]())

// 084 is one of the US three-digit ZIP areas the default holdout declares.
const heldOutPlace = { postcode: "08401" }
const trainedPlace = { postcode: "10001" }
const tags = ["house_number", "street", "locality", "region", "postcode"]

const policy = { frozen: { groups: new Set(["nad-1", "rend-7"]) }, validation: { groups: new Set(["oa-us-v"]) } }

describe("evaluationGroupOf", () => {
	it("reads the group the freeze and the overlap audit key on", () => {
		expect(evaluationGroupOf({ source_id: "nad-1" })).toBe("nad-1")
		expect(evaluationGroupOf({ source_id: "nad-1+case-lower", base_source_id: "nad-1" })).toBe("nad-1")
		expect(evaluationGroupOf({ source_id: "rend-7#ab12+drop-commas", base_source_id: null })).toBe("rend-7")
		expect(evaluationGroupOf({ source_id: "x+case-lower", base_source_id: "rend-7#ab12" })).toBe("rend-7")
	})
})

describe("splitForRow under the evaluation-group policy", () => {
	const split = (row: { source_id: string; base_source_id?: string | null; components: Record<string, string> }) =>
		splitForRow({ country: "US", span_tags: tags, ...row }, defaultHoldouts(), undefined, undefined, policy)

	it("sends every row of a frozen group to test, its variants and rendered rows included", () => {
		expect(split({ source_id: "nad-1", components: heldOutPlace })).toBe("test")
		expect(split({ source_id: "nad-1+case-lower", base_source_id: "nad-1", components: heldOutPlace })).toBe("test")
		expect(split({ source_id: "rend-7#ab12", components: heldOutPlace })).toBe("test")
		expect(split({ source_id: "rend-7#cd34+double-space", components: heldOutPlace })).toBe("test")
		// A variant whose rewritten components leave the held-out place stays with its group.
		expect(split({ source_id: "nad-1+case-lower", base_source_id: "nad-1", components: trainedPlace })).toBe("test")
	})

	it("keeps a frozen group out of train when retention protects its shape", () => {
		const retention = { floor: 10, protectedShapes: new Set([`US|${tags.join(" -> ")}`]) }

		const row = {
			source_id: "nad-1+case-lower",
			base_source_id: "nad-1",
			country: "US",
			components: heldOutPlace,
			span_tags: tags,
		}

		expect(splitForRow(row, defaultHoldouts(), undefined, retention)).toBe("train")
		expect(splitForRow(row, defaultHoldouts(), undefined, retention, policy)).toBe("test")
	})

	it("sends a validation group's rows to val, its variants included, and trains every other row", () => {
		expect(split({ source_id: "oa-us-v", components: heldOutPlace })).toBe("val")
		expect(split({ source_id: "oa-us-v+case-lower", base_source_id: "oa-us-v", components: trainedPlace })).toBe("val")
		expect(split({ source_id: "oa-us-1", components: heldOutPlace })).toBe("train")
		expect(split({ source_id: "oa-us-2", components: trainedPlace })).toBe("train")
	})
})

describe("the evaluation-group file", () => {
	it("reads back the groups it was built from", async () => {
		const path = directory.path("groups.json").toString()

		const drawnFrom = { corpusVersion: "v-test", sha256: "a".repeat(64) }

		const file = buildEvaluationGroupsFile({
			datasets: [
				{ datasetID: "dev", version: "1", drawnFrom, manifestSHA256: "b".repeat(64), rows: 3, groups: ["b", "a", "a"] },
				{ datasetID: "confirm", version: "2", drawnFrom, manifestSHA256: "c".repeat(64), rows: 1, groups: ["c"] },
			],
		})

		expect(file.groups).toEqual(["a", "b", "c"])
		expect(file.datasets.map((set) => set.groups)).toEqual([2, 1])

		await writeLocalJSONFile(file, path)

		const groups = await readEvaluationGroups(path)

		expect([...groups.groups].toSorted()).toEqual(["a", "b", "c"])
		expect(groups.sha256).toMatch(/^[0-9a-f]{64}$/u)
	})

	it("refuses a file that lists no group or is not an evaluation-group file", async () => {
		const empty = directory.path("empty.json").toString()
		const other = directory.path("other.json").toString()

		await writeLocalJSONFile(
			{
				...buildEvaluationGroupsFile({
					datasets: [
						{
							datasetID: "d",
							version: "1",
							drawnFrom: { corpusVersion: null, sha256: "" },
							manifestSHA256: "",
							rows: 0,
							groups: [],
						},
					],
				}),
			},
			empty
		)

		await writeLocalJSONFile({ attribute: "split", groups: ["a"] }, other)

		await expect(readEvaluationGroups(empty)).rejects.toThrow(/lists no group/u)
		await expect(readEvaluationGroups(other)).rejects.toThrow(/not an evaluation-group file/u)
	})

	it("commits the v0.8.18 list as one group per frozen group, drawn from one corpus manifest", async () => {
		const groups = await readEvaluationGroups(evaluationGroupsV0818Path())

		expect(groups.datasets.map((set) => set.datasetID)).toEqual(["heldout-dev-v0.8.18", "heldout-confirm-v0.8.18"])
		// The confirmation set was drawn with every development group excluded, so the two sets share no group.
		expect(groups.groups.size).toBe(groups.datasets.reduce((sum, set) => sum + set.groups, 0))
	})

	it("commits the v0.8.19 list as every v0.8.18 group plus the probe sets' groups, no set sharing a group", async () => {
		const earlier = await readEvaluationGroups(evaluationGroupsV0818Path())
		const groups = await readEvaluationGroups(evaluationGroupsV0819Path())

		expect(groups.datasets.map((set) => set.datasetID)).toEqual([
			"heldout-dev-v0.8.18",
			"heldout-confirm-v0.8.18",
			"heldout-dev-v0.8.19-probes-r2",
			"heldout-confirm-v0.8.19-probes-r2",
		])

		expect([...earlier.groups].filter((group) => !groups.groups.has(group))).toEqual([])
		expect(groups.groups.size).toBe(groups.datasets.reduce((sum, set) => sum + set.groups, 0))
	})
})
