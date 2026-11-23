// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   `geocodeStream` with the worker it spawns by default.
 *
 *   The wiring test beside it injects a fake worker, so it passes when the default
 *   worker's path points at no file or the worker's session fails to build.
 */

// ci-runner: mailwoman-data

import { dataRootPath } from "@mailwoman/core/data-root"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import type { SourceRecord } from "@mailwoman/entity-resolution"
import { wofDatabasePath } from "@mailwoman/resolver-wof-sqlite/paths"
import { describe, expect, it } from "vitest"

import { existingWOFDatabasePaths } from "#engine/resolver-backend"
import { geocodeStream } from "#geocode/batch/stream"

/**
 * The time one worker's session build and one geocode may take.
 */
const STREAM_TIMEOUT_MS = 120_000

describe.skipIf(!(await pathExists(wofDatabasePath("candidate.db"))))("geocodeStream with its default worker", () => {
	it(
		"geocodes a record through the worker's geocode session",
		async () => {
			const [wofDBPath] = await existingWOFDatabasePaths()

			const record: SourceRecord = {
				id: "0",
				source: null,
				name: null,
				organization: null,
				address: null,
				phone: null,
				email: null,
				attributes: null,
				raw: { addr: "1600 Pennsylvania Avenue NW, Washington, DC 20500" },
			}

			const geocoded: SourceRecord[] = []

			for await (const result of geocodeStream([record], {
				mapping: { address: ["addr"] },
				geocode: {
					dataRoot: dataRootPath().toString(),
					session: { resolveDB: wofDBPath ?? "", locale: "en-US", defaultCountry: "US" },
				},
				concurrency: 1,
			})) {
				geocoded.push(result)
			}

			expect(geocoded).toHaveLength(1)

			const coordinate = geocoded[0]!.address?.geocode?.coordinate

			// The White House, within a tenth of a degree, whichever street tier the data root holds.
			expect(coordinate?.latitude).toBeCloseTo(38.9, 1)
			expect(coordinate?.longitude).toBeCloseTo(-77.04, 1)
		},
		STREAM_TIMEOUT_MS
	)
})
