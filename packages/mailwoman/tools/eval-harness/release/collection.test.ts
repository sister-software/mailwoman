// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { afterAll, describe, expect, it } from "vitest"

import { writeHeldoutDataset } from "#tools/eval-harness/heldout/dataset/manifest"
import type { HeldoutRow } from "#tools/eval-harness/heldout/per/country"
import {
	type CollectionPinSource,
	readReportedCollections,
	verifyReportedCollection,
	verifyReportedCollections,
} from "#tools/eval-harness/release/collection"

const directory = await temporaryDirectory("mw-release-collection-")

afterAll(() => directory[Symbol.asyncDispose]())

const row = (raw: string, id = "a1"): HeldoutRow => ({
	raw,
	span_starts: [0, 3],
	span_ends: [2, raw.length],
	span_tags: ["house_number", "street"],
	country: "US",
	source: "oa-us",
	source_id: id,
	group: id,
})

const freeze = (name: string, raw: string, datasetID = "heldout-confirm-fixture", id = "a1") =>
	writeHeldoutDataset(directory.path(`${name}.json`), {
		datasetID,
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
		rows: [row(raw, id)],
	})

const OTHER = "heldout-dev-elsewhere@0123456789abcdef"

const spec = (
	confirmation: string[],
	dataset: Array<{ id: string; sha256: string }> = [],
	development: string[] = [OTHER]
): CollectionPinSource => ({
	identities: { dataset },
	evaluations: {
		development: { ids: development, description: "" },
		confirmation: { ids: confirmation, description: "" },
	},
})

const reportedOf = (name: string, manifest: { datasetID: string; version: string }) => ({
	path: directory.path(`${name}.json`).toString(),
	datasetID: manifest.datasetID,
	version: manifest.version,
})

describe("verifyReportedCollection", () => {
	it("admits a collection whose rows give the pinned version", async () => {
		const manifest = await freeze("pinned", "12 Main St")
		const id = `${manifest.datasetID}@${manifest.version}`

		await expect(
			verifyReportedCollection(spec([id], [{ id, sha256: manifest.rowsFile.sha256 }]), reportedOf("pinned", manifest))
		).resolves.toMatchObject({
			version: manifest.version,
			pinnedAs: ["identities.dataset", "evaluations.confirmation"],
		})
	})

	it("refuses a pin whose version differs from the version the rows on disk give, naming both", async () => {
		const pinned = await freeze("first", "12 Main St")
		const relabeled = await freeze("second", "12 Main Street")
		const id = `${pinned.datasetID}@${pinned.version}`
		const path = directory.path("second.json").toString()

		await expect(
			verifyReportedCollection(spec([id], [{ id, sha256: pinned.rowsFile.sha256 }]), reportedOf("second", relabeled))
		).rejects.toThrow(
			`pins identities.dataset as heldout-confirm-fixture@${pinned.version}; the rows at ${path} give heldout-confirm-fixture@${relabeled.version}`
		)
	})

	it("refuses a report whose recorded version differs from its collection's", async () => {
		const manifest = await freeze("recorded", "14 Main St")
		const path = directory.path("recorded.json").toString()

		await expect(
			verifyReportedCollection(spec([OTHER.replace("dev", "confirm")]), {
				path,
				datasetID: manifest.datasetID,
				version: "0000000000000000",
			})
		).rejects.toThrow(
			`records heldout-confirm-fixture@0000000000000000; ${path} holds heldout-confirm-fixture@${manifest.version}`
		)
	})
})

describe("verifyReportedCollections", () => {
	it("names the role whose every pinned collection the report scored, and no other", async () => {
		const main = await freeze("role-main", "16 Main St", "heldout-confirm-main", "m1")
		const probes = await freeze("role-probes", "PO Box 9", "heldout-confirm-probes", "p1")
		const ids = [`${main.datasetID}@${main.version}`, `${probes.datasetID}@${probes.version}`]

		const verified = await verifyReportedCollections(spec(ids), [
			reportedOf("role-main", main),
			reportedOf("role-probes", probes),
		])

		expect(verified.role).toBe("confirmation")
		expect(verified.reasons).toEqual([])

		expect(verified.collections.map((c) => c.pinnedAs)).toEqual([
			["evaluations.confirmation"],
			["evaluations.confirmation"],
		])
	})

	it("records a reason, naming the missing collection, when a report scores part of a role", async () => {
		const main = await freeze("part-main", "18 Main St", "heldout-confirm-part", "q1")
		const missing = "heldout-confirm-part-probes@fedcba9876543210"

		const verified = await verifyReportedCollections(spec([`${main.datasetID}@${main.version}`, missing]), [
			reportedOf("part-main", main),
		])

		expect(verified.role).toBeNull()
		expect(verified.reasons.find((reason) => reason.includes("confirmation"))).toMatch(`it lacks ${missing}`)
	})

	it("refuses a report that lists one dataset id twice", async () => {
		const main = await freeze("twice", "20 Main St", "heldout-confirm-twice", "t1")

		await expect(
			verifyReportedCollections(spec([`${main.datasetID}@${main.version}`]), [
				reportedOf("twice", main),
				reportedOf("twice", main),
			])
		).rejects.toThrow(/lists heldout-confirm-twice twice/u)
	})
})

describe("readReportedCollections", () => {
	it("reads null for a corpus-drawn report, one object as a list of one, and refuses a malformed entry", () => {
		const one = { path: "x.json", datasetID: "d", version: "0123456789abcdef" }

		expect(readReportedCollections({ dataset: null }, "report.json")).toBeNull()
		expect(readReportedCollections({ dataset: one }, "report.json")).toEqual([one])
		expect(readReportedCollections({ dataset: [one, { ...one, datasetID: "e" }] }, "report.json")).toHaveLength(2)
		expect(() => readReportedCollections({ dataset: [] }, "report.json")).toThrow(/empty dataset list/u)
		expect(() => readReportedCollections({ dataset: [{ path: "x.json" }] }, "report.json")).toThrow(/without a path/u)
	})
})
