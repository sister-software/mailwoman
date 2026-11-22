// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/json"
import type { PathBuilderLike } from "path-ts"
import { describe, expect, it } from "vitest"

import {
	auditPostcodeClones,
	FindingState,
	type PostcodeCloneAudit,
	type PostcodeClone,
} from "#tools/pipeline/wof/postcode-audit"

interface FixtureRecord {
	id: number
	name: string
	source?: string
	at?: [number, number]
	isoCountry?: string
	extra?: Record<string, unknown>
}

/**
 * Writes a clone's records under `directory` and returns the clone with the paths it lists.
 */
async function writeClone(
	directory: PathBuilderLike,
	country: string,
	records: readonly FixtureRecord[]
): Promise<{ clone: PostcodeClone; paths: string[] }> {
	const paths: string[] = []

	for (const record of records) {
		const [latitude, longitude] = record.at ?? [45.5, -122.6]
		const path = `data/${record.id}.geojson`

		await writeLocalTextFile(
			stringifyJSON({
				id: record.id,
				type: "Feature",
				properties: {
					"geom:latitude": latitude,
					"geom:longitude": longitude,
					"iso:country": record.isoCountry ?? country,
					"mz:is_current": -1,
					"src:geom": record.source ?? "uszcta",
					"wof:id": record.id,
					"wof:name": record.name,
					"wof:superseded_by": [],
					...record.extra,
				},
				geometry: { type: "Point", coordinates: [longitude, latitude] },
			}),
			`${directory.toString()}/${path}`
		)

		paths.push(path)
	}

	return {
		clone: { repo: `whosonfirst-data-postalcode-${country.toLowerCase()}`, directory, country },
		paths,
	}
}

const exportRow = (country: string, postcode: string) =>
	[country, postcode, "Place", "", "", "", "", "", "", "1", "1", ""].join("\t")

describe("auditPostcodeClones", () => {
	it("reports each finding over the current records and reads a territory's export before reporting absence", async () => {
		await using scratch = await temporaryDirectory("wof-postcode-audit-")
		const geonames = scratch.path("geonames-postal")

		await writeLocalTextFile(
			[exportRow("US", "97202"), exportRow("US", "75001"), ""].join("\n"),
			`${geonames.toString()}/US.txt`
		)

		await writeLocalTextFile(`${exportRow("GU", "96910")}\n`, `${geonames.toString()}/GU.txt`)
		await writeLocalTextFile(`${exportRow("FR", "75001")}\n`, `${geonames.toString()}/FR.txt`)

		const us = await writeClone(scratch.path("us"), "US", [
			{ id: 1, name: "97202" },
			{ id: 2, name: "Zip City" },
			{ id: 3, name: "99999", source: "geoplanet", at: [0, 0] },
			{ id: 4, name: "96910", source: "geoplanet", at: [0, 0], isoCountry: "GU" },
			{ id: 5, name: "75008", source: "geoplanet", at: [0, 0], extra: { "edtf:deprecated": "2026-11-22" } },
			{ id: 6, name: "96799", source: "geoplanet", at: [0, 0], isoCountry: "AS" },
			{ id: 7, name: "75001" },
			{ id: 8, name: "10001", extra: { "mz:is_current": 0 } },
			{ id: 9, name: "10002", extra: { "wof:superseded_by": [1] } },
		])

		const fr = await writeClone(scratch.path("fr"), "FR", [{ id: 100, name: "75001", source: "geoplanet", at: [0, 0] }])
		const ae = await writeClone(scratch.path("ae"), "AE", [{ id: 200, name: "00000" }])
		const lists = new Map([us, fr, ae].map(({ clone, paths }) => [clone.directory.toString(), paths]))

		const unlisted: PostcodeClone = {
			repo: "whosonfirst-data-postalcode-de",
			directory: scratch.path("de"),
			country: "DE",
		}

		const report = await auditPostcodeClones([us.clone, fr.clone, ae.clone, unlisted], {
			geonamesDirectory: geonames,
			async *listRecords(directory) {
				const paths = lists.get(directory.toString())

				if (!paths) throw new Error("git ls-files exited 128")

				yield* paths
			},
		})

		const [usAudit, frAudit, aeAudit, deAudit] = report.clones as [
			PostcodeCloneAudit,
			PostcodeCloneAudit,
			PostcodeCloneAudit,
			(typeof report.clones)[number],
		]

		expect(usAudit).toMatchObject({ records: 9, current: 6, skipped: 3 })
		expect(usAudit.format).toMatchObject({ state: FindingState.Measured, count: 1, ids: [2] })
		expect(usAudit.geometry).toMatchObject({ count: 3, ids: [3, 4, 6] })

		// 96910 is in GU.txt only. 96799 states AS, and the directory has no AS export.
		expect(usAudit.corroboration).toMatchObject({
			state: FindingState.Measured,
			count: 1,
			ids: [3],
			geoplanet: 3,
			geoplanetAbsentFromCountryExport: 3,
			corroboratedByTerritory: 1,
			territoryUnread: { count: 1, ids: [6] },
		})

		expect(usAudit.corroboration.exports.map((consulted) => [consulted.country, consulted.rows])).toEqual([
			["US", 2],
			["GU", 1],
			["AS", null],
		])

		expect(usAudit.shared).toMatchObject({ count: 1, ids: [7] })
		expect(frAudit.corroboration).toMatchObject({ count: 0, geoplanet: 1 })

		expect(report.shared).toEqual([
			{
				postcode: "75001",
				records: [
					{ country: "US", id: 7, format: true, geometry: true, corroboration: true },
					{ country: "FR", id: 100, format: true, geometry: false, corroboration: true },
				],
			},
		])

		// A country without a stated format or an export is unmeasured, never a count of zero.
		expect(aeAudit.format).toMatchObject({ state: FindingState.NoStatedFormat, count: null })
		expect(aeAudit.corroboration).toMatchObject({ state: FindingState.NoExport, count: null })

		expect(deAudit).toEqual({
			repo: "whosonfirst-data-postalcode-de",
			country: "DE",
			read: false,
			error: "git ls-files exited 128",
		})
	})

	it("reports a clone whose export is malformed as unmeasured", async () => {
		await using scratch = await temporaryDirectory("wof-postcode-audit-")
		const geonames = scratch.path("geonames-postal")

		await writeLocalTextFile("US\t97202\tPortland\n", `${geonames.toString()}/US.txt`)

		const us = await writeClone(scratch.path("us"), "US", [{ id: 1, name: "99999", source: "geoplanet", at: [0, 0] }])

		const report = await auditPostcodeClones([us.clone], { geonamesDirectory: geonames, listRecords: () => us.paths })
		const [audit] = report.clones as [PostcodeCloneAudit]

		expect(audit.corroboration).toMatchObject({ state: FindingState.ExportUnread, count: null, ids: [] })
		expect(audit.corroboration.reason).toContain("at row 1")
	})
})
