// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { readHeldoutDatasetRows } from "#tools/eval-harness/heldout/dataset/manifest"
import { buildProbeSets, type ProbeCandidate } from "#tools/eval-harness/heldout/probes/build"

let scratch: TemporaryDirectory

beforeEach(async () => {
	scratch = await temporaryDirectory("probe-sets-")
})

afterEach(() => scratch[Symbol.asyncDispose]())

const candidate = (source: string, country: string, i: number, template: string): ProbeCandidate => ({
	row: {
		raw: `PO Box ${i}, Town ${country}`,
		span_starts: [0],
		span_ends: [`PO Box ${i}`.length],
		span_tags: ["po_box"],
		country,
		source,
		source_id: `${source}-${country}-${i}`,
		group: `${source}-${country}-${i}`,
	},
	template,
})

describe("buildProbeSets", () => {
	it("never draws an excluded group or text, and keeps the two sets disjoint and on quota", async () => {
		const candidates = [
			...Array.from({ length: 40 }, (_, i) => candidate("probe-a", "AU", i, i % 3 ? "box" : "bag")),
			...Array.from({ length: 30 }, (_, i) => candidate("probe-b", "NZ", i, "unit")),
		]

		// Row 0's group trained, and row 1's text matches a training row's folded text.
		const folded = new Map(candidates.map((c) => [`${c.row.source}:${c.row.source_id}`, c.row.raw.toLowerCase()]))

		const built = await buildProbeSets({
			names: { development: "dev-probes", confirmation: "confirm-probes" },
			candidates,
			folded,
			exclusions: {
				groups: new Set(["probe-a-AU-0"]),
				texts: new Set(["po box 1, town au"]),
			},
			legs: [
				{ source: "probe-a", country: "AU", quota: 15 },
				{ source: "probe-b", country: "NZ", quota: 10 },
			],
			seeds: { development: 1, confirmation: 2 },
			floor: 2,
			render: {},
			excludedBy: [],
			outDirectory: scratch.path().toString(),
			createdAt: "2026-11-17T00:00:00.000Z",
		})

		const dev = await readHeldoutDatasetRows(built.development.path)
		const confirm = await readHeldoutDatasetRows(built.confirmation.path)
		const devGroups = new Set(dev.rows.map((row) => row.group))

		expect(dev.rows).toHaveLength(25)
		expect(confirm.rows).toHaveLength(25)
		expect(confirm.rows.filter((row) => devGroups.has(row.group))).toEqual([])
		expect(confirm.manifest.sampling.excludes).toEqual({ datasetID: "dev-probes", version: dev.manifest.version })

		for (const row of [...dev.rows, ...confirm.rows]) {
			expect(["probe-a-AU-0", "probe-a-AU-1"]).not.toContain(row.group)
		}

		expect(built.legs.find((leg) => leg.source === "probe-a")).toMatchObject({ rendered: 40, excluded: 2 })
	})

	it("refuses a leg whose supply cannot fill a quota rather than drawing fewer", async () => {
		await expect(
			buildProbeSets({
				names: { development: "dev-probes", confirmation: "confirm-probes" },
				candidates: [candidate("probe-a", "AU", 0, "box")],
				folded: new Map([["probe-a:probe-a-AU-0", "po box 0, town au"]]),
				exclusions: { groups: new Set(), texts: new Set() },
				legs: [{ source: "probe-a", country: "AU", quota: 1 }],
				seeds: { development: 1, confirmation: 2 },
				floor: 1,
				render: {},
				excludedBy: [],
				outDirectory: scratch.path().toString(),
				createdAt: "2026-11-17T00:00:00.000Z",
			})
		).rejects.toThrow(/holds 0 candidates; the quota is 1/u)
	})
})
