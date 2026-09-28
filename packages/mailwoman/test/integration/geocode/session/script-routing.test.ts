/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { pathExists } from "@mailwoman/core/fs/readers"
import { wofDatabasePath } from "@mailwoman/resolver-wof-sqlite/paths"
import { haversineKm } from "@mailwoman/spatial"
import { createGeocodeCommandOptions, createGeocodeSession } from "mailwoman/geocode"
import { afterAll, describe, expect, it } from "vitest"

const CANDIDATE_DB = wofDatabasePath("candidate.db")

const haveArtifacts =
	(await pathExists(CANDIDATE_DB)) && (await pathExists(dataRootPath("weights", "cjk", "model.onnx")))

// Kamiichi's entrance point for the JP board row.
// The served municipality centroid sits 4.9 km from it.
const KAMIICHI = { lat: 36.658101, lon: 137.384089 }

describe.skipIf(!haveArtifacts)("createGeocodeSession — a bare kanji line under --locale en-US (#2164 routing)", () => {
	const sessionPromise = haveArtifacts
		? createGeocodeSession(createGeocodeCommandOptions({ locale: "en-US", candidateDB: CANDIDATE_DB.toString() }))
		: undefined

	afterAll(async () => {
		;(await sessionPromise)?.[Symbol.dispose]()
	})

	it("parses on the CJK family and resolves the municipality without the locale's country scope", async () => {
		const session = await sessionPromise!
		const run = await session.geocode("富山県中新川郡上市町大岩148-7")

		expect(run.result.components).toMatchObject({
			prefecture: "富山県",
			municipality: "中新川郡上市町",
			district: "大岩",
			house_number: "148-7",
		})

		expect(run.result.lat).not.toBeNull()
		expect(haversineKm(run.result.lat!, run.result.lon!, KAMIICHI.lat, KAMIICHI.lon)).toBeLessThan(15)
	})

	it("keeps a Latin line on the primary with the locale scope in force", async () => {
		const session = await sessionPromise!
		const run = await session.geocode("1600 Amphitheatre Parkway, Mountain View, CA 94043")

		expect(run.result.components.locality).toBe("Mountain View")
		expect(run.result.lat).not.toBeNull()
	})
})
