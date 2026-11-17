// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { afterAll, describe, expect, it } from "vitest"

import { writeHeldoutDataset } from "#tools/eval-harness/heldout/dataset/manifest"
import type { HeldoutRow } from "#tools/eval-harness/heldout/per/country"
import { readReportedCollection, verifyReportedCollection } from "#tools/eval-harness/release/collection"

const directory = await temporaryDirectory("mw-release-collection-")

afterAll(() => directory[Symbol.asyncDispose]())

const row = (raw: string): HeldoutRow => ({
	raw,
	span_starts: [0, 3],
	span_ends: [2, raw.length],
	span_tags: ["house_number", "street"],
	country: "US",
	source: "oa-us",
	source_id: "a1",
	group: "a1",
})

const freeze = (name: string, raw: string) =>
	writeHeldoutDataset(directory.path(`${name}.json`), {
		datasetID: "heldout-confirm-fixture",
		createdAt: "2026-11-17T00:00:00.000Z",
		drawnFrom: { manifest: "/data/MANIFEST.json", sha256: "a".repeat(64), corpusVersion: null, files: [] },
		sampling: {
			method: "per-record-id-country-kind-hash-order",
			perCountry: 1,
			seed: null,
			order: "hash(raw)",
			engine: "duckdb v1.4.0",
		},
		cells: [{ country: "US", kind: "address", available: 1, sampled: 1 }],
		rows: [row(raw)],
	})

const spec = (id: string | null, sha256: string | null = null) => ({
	identities: {
		dataset: { id, sha256 },
	} as never,
	evaluations: {
		development: { id: null, description: "" },
		confirmation: { id, description: "" },
	},
})

describe("verifyReportedCollection", () => {
	it("admits a collection whose rows give the pinned version", async () => {
		const manifest = await freeze("pinned", "12 Main St")
		const id = `${manifest.datasetID}@${manifest.version}`

		const reported = {
			path: directory.path("pinned.json").toString(),
			datasetID: manifest.datasetID,
			version: manifest.version,
		}

		await expect(verifyReportedCollection(spec(id, manifest.rowsFile.sha256), reported)).resolves.toMatchObject({
			version: manifest.version,
			pinnedAs: ["identities.dataset", "evaluations.confirmation"],
		})
	})

	it("refuses a pin whose version differs from the version the rows on disk give, naming both", async () => {
		const pinned = await freeze("first", "12 Main St")
		const relabeled = await freeze("second", "12 Main Street")
		const path = directory.path("second.json").toString()

		await expect(
			verifyReportedCollection(spec(`${pinned.datasetID}@${pinned.version}`), {
				path,
				datasetID: relabeled.datasetID,
				version: relabeled.version,
			})
		).rejects.toThrow(
			`pins identities.dataset as heldout-confirm-fixture@${pinned.version}; the rows at ${path} give heldout-confirm-fixture@${relabeled.version}`
		)
	})

	it("refuses a report whose recorded version differs from its collection's", async () => {
		const manifest = await freeze("recorded", "14 Main St")
		const path = directory.path("recorded.json").toString()

		await expect(
			verifyReportedCollection(spec(null), { path, datasetID: manifest.datasetID, version: "0000000000000000" })
		).rejects.toThrow(
			`records heldout-confirm-fixture@0000000000000000; ${path} holds heldout-confirm-fixture@${manifest.version}`
		)
	})
})

describe("readReportedCollection", () => {
	it("reads null for a corpus-drawn report and refuses a malformed dataset field", () => {
		expect(readReportedCollection({ dataset: null }, "report.json")).toBeNull()
		expect(() => readReportedCollection({ dataset: { path: "x.json" } }, "report.json")).toThrow(/without a path/u)
	})
})
