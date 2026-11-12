// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   A relative-place description resolves to no place unless it states one (#3022).
 *
 *   The parser reads `Behind the gas station` as a venue.
 *   Span rescore then matches its last word, `station`, to Station, Kentucky.
 *
 *   That span leaves the rest of the name behind, so the geocode keeps the locality only
 *   when a venue answers near it.
 *   With no such venue the input is unresolved.
 *
 *   The same description followed by `Station KY` states the town, and the town answers.
 */

import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { wofDatabasePath } from "@mailwoman/resolver-wof-sqlite/paths"
import { afterAll, describe, expect, it } from "vitest"

import { createGeocodeCommandOptions, createGeocodeSession } from "#geocode"

const CANDIDATE_DB = wofDatabasePath("candidate.db")
const haveArtifacts = await pathExists(CANDIDATE_DB)

// Station, Kentucky, the town the description's last word spells.
const STATION_KY = "wof:1343272895"

describe.skipIf(!haveArtifacts)("geocode — a relative-place description (#3022)", () => {
	const sessionPromise = haveArtifacts
		? createGeocodeSession(createGeocodeCommandOptions({ locale: "en-US", candidateDB: CANDIDATE_DB.toString() }))
		: null

	afterAll(async () => {
		await (await sessionPromise)?.[Symbol.asyncDispose]()
	})

	it("leaves `Behind the gas station` unresolved rather than answering with the town its last word spells", async () => {
		const { result } = await (await sessionPromise!).geocode("Behind the gas station")

		expect(result.components).toEqual({ venue: "Behind the gas station" })
		expect(result.epistemic_status).toBe("unresolved")
		expect(result.lat).toBeNull()
		expect(result.hierarchy.map((place) => place.placeID)).not.toContain(STATION_KY)
	}, 60_000)

	it("answers with Station, Kentucky when the input states the town", async () => {
		const { result } = await (await sessionPromise!).geocode("Behind the gas station, Station KY")

		expect(result.components).toMatchObject({ locality: "Station", region: "KY" })
		expect(result.epistemic_status).toBe("observed")
		expect(result.lat).not.toBeNull()
		expect(result.hierarchy.find((place) => place.tag === "locality")?.placeID).toBe(STATION_KY)
	}, 60_000)
})
