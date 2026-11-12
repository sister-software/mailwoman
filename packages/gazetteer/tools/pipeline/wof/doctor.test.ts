// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/json"
import type { PathBuilderLike } from "path-ts"
import { describe, expect, it } from "vitest"

import {
	diagnoseClones,
	finalSuccessors,
	readDeprecatedMapping,
	readRecordProperties,
	recordReferences,
} from "#tools/pipeline/wof/doctor"

const write = (path: PathBuilderLike, text: string) => writeLocalTextFile(text, path)

/**
 * A record in the WOF exporter's layout: properties first, the geometry last on one line.
 */
function exportedRecord(properties: Record<string, unknown>): string {
	const lines = Object.entries(properties).map(([key, value]) => `    ${stringifyJSON(key)}:${stringifyJSON(value)}`)

	return [
		"{",
		`  "id": ${String(properties["wof:id"])},`,
		'  "type": "Feature",',
		'  "properties": {',
		lines.join(",\n"),
		"  },",
		'  "bbox": [0,0,1,1],',
		'  "geometry": {"coordinates":[0.5,0.5],"type":"Point"}',
		"}",
		"",
	].join("\n")
}

describe("readRecordProperties", () => {
	it("reads the properties of a record whose geometry comes last", async () => {
		await using scratch = await temporaryDirectory("wof-doctor-")
		const path = scratch.path("1.geojson")

		await write(path, exportedRecord({ "wof:id": 1, "wof:name": "Alpha" }))

		expect(await readRecordProperties(path)).toEqual({
			properties: { "wof:id": 1, "wof:name": "Alpha" },
			wholeFile: false,
		})
	})

	it("keeps a multi-byte character that straddles the first read", async () => {
		await using scratch = await temporaryDirectory("wof-doctor-")
		const path = scratch.path("2.geojson")
		// The padding puts "é" across the 64 KiB boundary of the first read.
		const name = `${"a".repeat(64 * 1024 - 110)}éé${"b".repeat(20)}`

		await write(path, exportedRecord({ "wof:id": 2, "wof:name": name }))

		const { properties } = await readRecordProperties(path)

		expect(properties["wof:name"]).toBe(name)
	})

	it("parses a record laid out in another order whole", async () => {
		await using scratch = await temporaryDirectory("wof-doctor-")
		const path = scratch.path("3.geojson")

		await write(path, stringifyJSON({ geometry: { type: "Point", coordinates: [0, 0] }, properties: { "wof:id": 3 } }))

		expect(await readRecordProperties(path)).toEqual({ properties: { "wof:id": 3 }, wholeFile: true })
	})
})

describe("recordReferences", () => {
	it("reads the parent and every hierarchy ancestor, leaving out placeholders", () => {
		const refs = recordReferences({
			"wof:id": 10,
			"wof:parent_id": 20,
			"wof:hierarchy": [{ locality_id: 20, region_id: 30, county_id: -1 }, { region_id: 31 }],
		})

		expect(refs?.references).toEqual([
			{ key: "parent", id: 20 },
			{ key: "locality", id: 20 },
			{ key: "region", id: 30 },
			{ key: "region", id: 31 },
		])
	})

	it("reports a superseded record and a deprecated record without a successor", () => {
		expect(recordReferences({ "wof:id": 1, "wof:superseded_by": [2] })).toMatchObject({
			superseded: true,
			deprecated: false,
		})

		expect(recordReferences({ "wof:id": 1, "edtf:deprecated": "2020-03-08" })).toMatchObject({
			superseded: false,
			deprecated: true,
		})

		expect(recordReferences({ "wof:id": 1, "edtf:deprecated": "uuuu" })).toMatchObject({ deprecated: false })
	})
})

describe("finalSuccessors", () => {
	it("follows a chain to the IDs that have no entry, and stops at a cycle", () => {
		const mapping = new Map<number, number[]>([
			[1, [2]],
			[2, [3, 4]],
			[5, [6]],
			[6, [5]],
			[7, []],
		])

		expect(finalSuccessors(1, mapping).toSorted()).toEqual([3, 4])
		expect(finalSuccessors(5, mapping)).toEqual([])
		expect(finalSuccessors(7, mapping)).toEqual([])
	})
})

describe("diagnoseClones", () => {
	it("reports retired records, dangling references and listed successors no clone carries", async () => {
		await using scratch = await temporaryDirectory("wof-doctor-")

		const files: Record<string, Record<string, string>> = {
			"clone-a": {
				"data/100.geojson": exportedRecord({ "wof:id": 100, "wof:parent_id": 200 }),
				// 300 is gone from every clone.
				// The mapping leads it to 400, and clone-b holds 400.
				"data/101.geojson": exportedRecord({
					"wof:id": 101,
					"wof:parent_id": 300,
					"wof:hierarchy": [{ region_id: 300 }],
				}),
				"data/102.geojson": exportedRecord({ "wof:id": 102, "wof:superseded_by": [100] }),
				"data/bad.geojson": "{ not json",
			},
			"clone-b": {
				"data/200.geojson": exportedRecord({ "wof:id": 200, "wof:hierarchy": [{ region_id: 500 }] }),
				"data/400.geojson": exportedRecord({ "wof:id": 400 }),
				"data/401.geojson": exportedRecord({ "wof:id": 401, "edtf:deprecated": "2019-01-01" }),
			},
		}

		for (const [clone, entries] of Object.entries(files)) {
			for (const [path, text] of Object.entries(entries)) {
				await write(scratch.path(clone, path), text)
			}
		}

		const listRecords = (directory: PathBuilderLike) => Object.keys(files[directory.toString().split("/").at(-1)!]!)

		const mapping = new Map<number, number[]>([
			[300, [400]],
			[600, [601]],
		])

		const report = await diagnoseClones(
			[
				{ repo: "clone-a", directory: scratch.path("clone-a") },
				{ repo: "clone-b", directory: scratch.path("clone-b") },
			],
			mapping,
			{ listRecords }
		)

		expect(report.records).toBe(6)
		expect(report.unreadable.count).toBe(1)
		expect(report.unreadable.sample[0]?.path).toBe("data/bad.geojson")
		expect(report.retired).toMatchObject({ superseded: 1, deprecated: 1 })

		expect(report.retired.byRepo).toEqual({
			"clone-a": { superseded: 1, deprecated: 0 },
			"clone-b": { superseded: 0, deprecated: 1 },
		})

		// 300 (listed, resolvable) and 500 (unlisted) are referenced and absent.
		// Record 101 gives 300 as its parent and as its region: two references from one referrer.
		expect(report.dangling).toMatchObject({
			ids: 2,
			references: 3,
			listed: 1,
			resolvable: 1,
			byKey: { parent: 1, region: 2 },
		})

		expect(report.dangling.sample.find((entry) => entry.id === 300)).toMatchObject({
			referencedBy: [101],
			successors: [400],
		})

		expect(report.mapping).toMatchObject({ read: true, entries: 2, successorMissing: 1 })
		expect(report.mapping.sample).toEqual([{ id: 600, successors: [601] }])
	})
})

describe("readDeprecatedMapping", () => {
	it("reads each ID's successors and an empty file as no successor", async () => {
		await using scratch = await temporaryDirectory("wof-doctor-")

		await write(scratch.path("data/101/846/037/101846037"), "101792059\n")
		await write(scratch.path("data/437/292/839/437292839"), "")
		await write(scratch.path("README.md"), "# readme\n")

		const mapping = await readDeprecatedMapping(scratch.path(), () => [
			"data/101/846/037/101846037",
			"data/437/292/839/437292839",
			"README.md",
		])

		expect(mapping).toEqual(
			new Map([
				[101_846_037, [101_792_059]],
				[437_292_839, []],
			])
		)
	})

	it("refuses a line that is not an ID", async () => {
		await using scratch = await temporaryDirectory("wof-doctor-")

		await write(scratch.path("data/1/1"), "oops\n")

		await expect(readDeprecatedMapping(scratch.path(), () => ["data/1/1"])).rejects.toThrow('"oops" is not an ID')
	})
})
