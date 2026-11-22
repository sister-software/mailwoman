// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   A request's `defaultCountry` scopes that request's resolver and leaves the session's scope as it was.
 */

import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { wofDatabasePath } from "@mailwoman/resolver-wof-sqlite/paths"
import { describe, expect, it } from "vitest"

import { createGeocodeSessionOptions } from "#geocode/options"
import { createGeocodeSession } from "#geocode/session"

const haveGazetteer = await pathExists(wofDatabasePath("candidate.db"))

describe.skipIf(!haveGazetteer)("a request's default country", () => {
	it("scopes that request, and the next request without one is unscoped again", async () => {
		await using session = await createGeocodeSession(createGeocodeSessionOptions({ countryScope: "none" }))

		const before = await session.geocode("Paris")
		const scoped = await session.geocode("Paris", { defaultCountry: "US" })
		const after = await session.geocode("Paris")

		expect({
			before: before.result.countryCode,
			scoped: scoped.result.countryCode,
			after: after.result.countryCode,
		}).toEqual({ before: "FR", scoped: "US", after: "FR" })

		expect(after.result).toEqual(before.result)
	}, 120_000)
})
